import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PlanFiles, digest, normalizePlan, titleOf, MAX_BYTES } from "./files.ts";
import { CONTEXT, REVIEW, STATE, SUBMIT, emptyState, planning, restoreState, type PlanState, type PlanRef } from "./state.ts";
import { kickoff, offPrompt, planPrompt, revisionRequest } from "./prompts.ts";
import { selectReview, type ReviewDecision } from "./review-ui.ts";
import { HANDOFF, approvedBody, projectHandoff, userText, type HandoffMarker } from "./handoff.ts";

export default function planMode(pi: ExtensionAPI) {
  const files = new PlanFiles(join(getAgentDir(), "plans"));
  let state = emptyState();
  let generation = 0;
  let sessionId = "";
  let menuAbort: AbortController | undefined;
  let autoToken: string | undefined;
  let reviewing = false;
  let errorState: string | undefined;
  let startingKickoff: { hash: string; generation: number } | undefined;
  let pendingHandoff: { request: string; approved: PlanRef } | undefined;

  function invalidate() {
    generation++;
    autoToken = undefined;
    startingKickoff = undefined;
    pendingHandoff = undefined;
    menuAbort?.abort();
  }
  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus("review-plan", errorState ? "计划状态错误" : state.mode === "ready" ? "计划待确认 · /plan" : planning(state) ? "规划中 · /plan" : undefined);
  }
  function save(next: PlanState, ctx: ExtensionContext) {
    pi.appendEntry(STATE, next);
    state = next;
    status(ctx);
  }
  const valid = (g: number, s: PlanState, id: string) => generation === g && state === s && sessionId === id;
  function assertUsable(ctx: ExtensionContext) {
    if (errorState) throw new Error(errorState);
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("请等当前工作和排队消息结束后再操作 /plan。");
  }
  function begin(ctx: ExtensionContext) {
    assertUsable(ctx);
    invalidate();
    save({ ...emptyState(), workflow: state.workflow ?? randomUUID(), mode: "planning", proposal: state.proposal, approved: state.approved }, ctx);
    ctx.ui.notify("已进入规划。仅当前计划文件可用 edit/write 修改；其他探测保留。", "info");
  }
  function exit(ctx: ExtensionContext) {
    assertUsable(ctx);
    invalidate();
    save({ ...state, mode: "off", pendingRuntime: undefined, pendingKickoff: undefined }, ctx);
    ctx.ui.notify("已退出规划；计划文件保留，未启动执行。", "info");
  }
  function display(body: string, ref: PlanRef, label: string) {
    pi.appendEntry(REVIEW, { body, path: ref.path, hash: digest(body), label });
  }
  async function show(ctx: ExtensionContext) {
    const ref = state.proposal ?? state.approved;
    if (!ref) throw new Error("当前会话没有计划。用 /plan start 开始。");
    const g = generation, s = state, id = sessionId;
    const body = await files.read(ref, ref === state.approved);
    if (valid(g, s, id)) display(body, ref, state.mode === "ready" ? "待确认计划" : "计划参考（不代表执行授权）");
  }
  async function preflight(ctx: ExtensionContext) {
    if (!ctx.model) throw new Error("当前未选择模型，不能启动执行。");
    if (!ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)) throw new Error("当前模型已不可用；未启动执行。");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw new Error("当前模型认证不可用；未启动执行，也未切换模型。");
  }

  async function approve(ctx: ExtensionCommandContext, body: string, ref: PlanRef, destination: "here" | "fresh", g: number, s: PlanState, id: string) {
    await preflight(ctx);
    if (!valid(g, s, id)) return;
    assertUsable(ctx);
    if (digest(await files.read(ref)) !== digest(body)) throw new Error("计划在审阅后发生变化。请重新打开 /plan 审阅。");
    if (!valid(g, s, id)) return;
    const approved = await files.create(body, "approved");
    if (!valid(g, s, id)) return;
    // Check again after I/O: the document may have changed while the snapshot was written.
    if (digest(await files.read(ref)) !== digest(body)) throw new Error("计划已变化；本次未批准。请重新审阅。");
    if (!valid(g, s, id)) return;
    const model = ctx.model!;
    const runtime = { provider: model.provider, modelId: model.id, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel() };
    const request = kickoff(approved, body);
    const cwd = ctx.cwd;
    invalidate();
    // A fresh handoff leaves its source reviewable, even if replacement or kickoff fails.
    const next: PlanState = { ...state, mode: "ready", approved,
      proposal: { ...ref, hash: digest(body), title: titleOf(body) },
      pendingRuntime: undefined, pendingKickoff: destination === "here" ? digest(request) : undefined, handoffError: undefined };
    save(next, ctx);
    if (destination === "here") {
      // This API is fire-and-forget. Keep the proposal ready until agent_start acknowledges this request.
      pi.sendUserMessage(request);
      return;
    }
    const destinationState: PlanState = { version: 1, mode: "off", workflow: state.workflow, approved, pendingRuntime: runtime };
    try {
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async sm => { sm.appendCustomEntry(STATE, destinationState); },
        withSession: async replacement => {
          const restored = restoreState(replacement.sessionManager.getBranch());
          if (restored.handoffError || restored.pendingRuntime || replacement.model?.provider !== runtime.provider ||
            replacement.model?.id !== runtime.modelId || replacement.thinkingLevel !== runtime.thinking || replacement.cwd !== cwd) {
            replacement.ui.notify("新会话已创建，但环境未保持一致，未启动执行。请返回原会话检查。", "error");
            return;
          }
          try { await replacement.sendUserMessage(request); }
          catch (error) {
            replacement.ui.setEditorText(request);
            replacement.ui.notify(`交接请求未完成：${String(error)}。请求保留在输入框；不会自动重试。`, "error");
          }
        },
      });
      if (result.cancelled && sessionId === id && state === next) {
        save(s, ctx);
        ctx.ui.notify("新会话已取消；原计划仍可审批。", "info");
      }
    } catch (error) {
      if (sessionId === id && state === next) save(s, ctx);
      throw error;
    }
  }

  async function review(ctx: ExtensionCommandContext, destination?: "here" | "fresh") {
    assertUsable(ctx);
    if (!ctx.hasUI) throw new Error("计划审批需要交互界面；请在终端打开 /plan。");
    if (state.mode !== "ready" || !state.proposal) throw new Error("没有可审批的完整计划。请先提交或重新提交计划。");
    if (reviewing) return;
    reviewing = true;
    autoToken = undefined;
    const controller = new AbortController();
    menuAbort = controller;
    try {
      save({ ...state, shown: state.proposal.id }, ctx);
      const s = state, g = generation, id = sessionId, ref = state.proposal!;
      const body = await files.read(ref);
      if (!valid(g, s, id)) return;
      display(body, ref, "请审阅目标、验收标准和假设");
      let choice: ReviewDecision | undefined;
      if (destination) {
        const yes = await ctx.ui.confirm("执行刚展示的计划？", destination === "fresh" ? "保留旧会话，在关联新会话执行。" : "在当前会话执行。", { signal: controller.signal });
        choice = yes ? { action: destination } : undefined;
      } else {
        choice = await selectReview(ctx, controller.signal);
      }
      if (controller.signal.aborted || !valid(g, s, id)) return;
      if (choice?.action === "revise") {
        invalidate();
        save({ ...state, mode: "planning", pendingKickoff: undefined }, ctx);
        const feedback = choice.feedback?.trim();
        if (feedback) pi.sendUserMessage(revisionRequest(feedback), { deliverAs: "followUp" });
        else ctx.ui.notify("继续讨论并修改当前计划文件；提交审阅后再审批。", "info");
      } else if (choice?.action === "here" || choice?.action === "fresh") {
        await approve(ctx, body, ref, choice.action, g, s, id);
      }
    } finally {
      if (menuAbort === controller) menuAbort = undefined;
      reviewing = false;
    }
  }

  pi.registerShortcut("alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      try {
        if (planning(state)) exit(ctx);
        else begin(ctx);
      } catch (error) {
        ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
      }
    },
  });

  pi.registerCommand("plan", {
    description: "规划与审批：/plan [start|show|implement|fresh|exit|export <path>|任务]",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command.startsWith("__review ")) {
          if (command.slice(9) !== autoToken) return;
          autoToken = undefined;
          return await review(ctx);
        }
        if (command === "show") return await show(ctx);
        if (command === "exit" || command === "off") return exit(ctx);
        if (command === "implement" || command === "fresh") return await review(ctx, command === "fresh" ? "fresh" : "here");
        if (command.startsWith("export ")) {
          assertUsable(ctx);
          const ref = state.proposal ?? state.approved;
          if (!ref) throw new Error("没有可导出的计划。");
          const body = await files.read(ref, ref === state.approved);
          const target = resolve(ctx.cwd, command.slice(7).trim());
          await writeFile(target, body, { flag: "wx", mode: 0o600 });
          ctx.ui.notify(`已导出：${target}`, "info");
          return;
        }
        if (command === "start") return begin(ctx);
        if (command) {
          begin(ctx);
          pi.sendUserMessage(command);
          return;
        }
        assertUsable(ctx);
        if (state.mode === "ready") return await review(ctx);
        if (!ctx.hasUI) throw new Error("/plan 菜单需要交互界面；用 /plan start 开始规划。");
        const g = generation, id = sessionId, s = state;
        const options = planning(state) ? ["查看上一版", "退出规划，保留文件"] : ["开始规划", "查看保留的计划"];
        const choice = await ctx.ui.select("Plan Mode", options);
        if (!valid(g, s, id)) return;
        if (choice === "开始规划") begin(ctx);
        else if (choice === "退出规划，保留文件") exit(ctx);
        else if (choice) await show(ctx);
      } catch (error) {
        if (!ctx.hasUI) throw error;
        try { ctx.ui.notify(String(error instanceof Error ? error.message : error), "error"); } catch { /* replaced context */ }
      }
    },
  });

  pi.registerTool({
    name: SUBMIT,
    label: "提交计划",
    exposure: "model-only",
    executionMode: "sequential",
    description: "Submit the current plan file for review with {}. On first submission, supply complete Markdown in plan. Later edits reuse the same file; optional plan replaces its content. Does not approve or execute. Call alone as the final action. Limit: 50,000 UTF-8 bytes.",
    parameters: Type.Object({ plan: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_BYTES })) }),
    async execute(_callId, params, signal, _update, ctx) {
      if (errorState || !planning(state)) throw new Error("plan_submit is only available in active Plan mode.");
      const s = state, g = generation, id = sessionId;
      const current = () => !signal?.aborted && valid(g, s, id);
      signal?.throwIfAborted();
      let ref: PlanRef;
      if (params.plan !== undefined) {
        const body = normalizePlan(params.plan);
        ref = s.proposal ? await files.update(s.proposal, body, current) : await files.create(body);
      } else {
        if (!s.proposal) throw new Error("No current plan file. Supply the complete Markdown in plan once.");
        const body = await files.read(s.proposal);
        ref = { ...s.proposal, hash: digest(body), title: titleOf(body) };
      }
      signal?.throwIfAborted();
      if (!current()) throw new Error("Planning changed during submission. This proposal was not activated.");
      save({ ...state, mode: "ready", proposal: ref, shown: undefined, pendingKickoff: undefined }, ctx);
      return { content: [{ type: "text" as const, text: `计划已保存，等待用户审批：${ref.path}` }], details: { ref }, terminate: true };
    },
    renderCall: args => new Text(`提交计划 · ${typeof args.plan === "string" ? titleOf(args.plan) : "当前文件"}`, 0, 0),
    renderResult: result => new Text(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0),
  });
  pi.registerEntryRenderer(REVIEW, entry => {
    const d = entry.data as { body: string; label: string; path: string };
    return new Markdown(`**${d.label}**\n\n${d.body}\n\n文件：\`${d.path}\``, 0, 0, getMarkdownTheme());
  });

  pi.on("tool_call", async (event, ctx) => {
    if ((planning(state) || errorState) && (event.toolName === "edit" || event.toolName === "write")) {
      const s = state, g = generation, id = sessionId;
      if (errorState || !s.proposal || !(await files.canEdit(s.proposal, event.input.path, ctx.cwd)) || !valid(g, s, id)) {
        return { block: true, reason: "Plan mode only allows edit/write on the current draft. Do not use another tool to implement early." };
      }
      if (state.mode === "ready") {
        invalidate();
        save({ ...state, mode: "planning", pendingKickoff: undefined }, ctx);
      }
    }
    if (event.toolName === SUBMIT) {
      if (errorState || !planning(state)) return { block: true, reason: "Plan mode is not active." };
      const last = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "message" && e.message.role === "assistant") as any;
      const calls = last?.message.content?.filter((b: any) => b.type === "toolCall") ?? [];
      if (calls.length !== 1 || calls[0].id !== event.toolCallId) {
        return { block: true, reason: "Submit the complete plan alone in its own tool call." };
      }
    }
  });
  pi.on("input", (event, ctx) => {
    const handoff = !errorState && event.source === "extension" && state.approved && approvedBody(state.approved, event.text)
      ? { request: event.text, approved: state.approved } : undefined;
    if (event.source === "extension" && state.pendingKickoff === digest(event.text)) {
      pendingHandoff = handoff;
      return;
    }
    invalidate();
    pendingHandoff = handoff;
    if (state.mode === "ready") save({ ...state, mode: "planning", pendingKickoff: undefined }, ctx);
  });
  pi.on("before_agent_start", event => {
    startingKickoff = event.messageType === "user" && state.pendingKickoff === digest(event.prompt)
      ? { hash: state.pendingKickoff, generation } : undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    const starting = startingKickoff;
    startingKickoff = undefined;
    if (starting && starting.generation === generation && starting.hash === state.pendingKickoff && !ctx.signal?.aborted) {
      save({ ...state, mode: "off", pendingKickoff: undefined }, ctx);
    }
  });
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter((m: any) => !(m.role === "custom" && m.customType === CONTEXT));
    if (!state.workflow && !errorState) return { messages };
    const content = planning(state) || errorState ? planPrompt(ctx.hasUI && pi.getActiveTools().includes("ask_user_question"), state.proposal?.path) : offPrompt;
    messages.push({ role: "custom", customType: CONTEXT, content, display: false, timestamp: 0 });
    return { messages };
  });
  pi.on("context_with_system", (event, ctx) => {
    if (errorState) return;
    // Record ownership only after an extension-origin handoff actually enters the session.
    const pending = pendingHandoff;
    if (pending && pending.approved.id === state.approved?.id && pending.approved.hash === state.approved.hash) {
      const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && userText(e.message) === pending.request);
      if (entry) {
        pendingHandoff = undefined;
        pi.appendEntry(HANDOFF, { version: 1, messageId: entry.id, requestHash: digest(pending.request),
          approvedId: pending.approved.id, approvedHash: pending.approved.hash } satisfies HandoffMarker);
      }
    }
    return { messages: projectHandoff(event.messages, ctx.sessionManager.getBranch(), ctx.sessionManager.buildSessionProjection(), state.approved) };
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (state.mode !== "ready" || !state.proposal || state.shown === state.proposal.id || !ctx.hasUI || ctx.hasPendingMessages()) return;
    save({ ...state, shown: state.proposal.id }, ctx);
    autoToken = randomUUID();
    pi.sendUserMessage(`/plan __review ${autoToken}`, { expandPromptTemplates: true });
  });
  async function reconcileDraft(ctx: ExtensionContext) {
    if (state.mode !== "ready" || !state.proposal) return;
    const s = state, g = generation, id = sessionId;
    let unchanged = false;
    try { unchanged = digest(await files.read(s.proposal!)) === s.proposal!.hash; } catch { /* require a new submission */ }
    if (!unchanged && valid(g, s, id)) {
      invalidate();
      save({ ...s, mode: "planning", shown: undefined, pendingKickoff: undefined }, ctx);
      ctx.ui.notify("当前草稿已变化或不可读；未恢复旧审批。请检查当前文件并重新提交审阅。", "warning");
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    invalidate();
    sessionId = ctx.sessionManager.getSessionId();
    try {
      state = restoreState(ctx.sessionManager.getBranch());
      errorState = undefined;
      await reconcileDraft(ctx);
      if (state.pendingRuntime) {
        const target = state.pendingRuntime;
        const model = ctx.modelRegistry.find(target.provider, target.modelId);
        let failure: string | undefined;
        try {
          if (!model || !(await pi.setModel(model))) throw new Error("原模型不可用或未认证");
          pi.setThinkingLevel(target.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
        } catch (error) { failure = String(error); }
        save({ ...state, pendingRuntime: undefined, handoffError: failure }, ctx);
      }
    } catch (error) { errorState = String(error); ctx.ui.notify(errorState, "error"); }
    status(ctx);
  });
  pi.on("session_before_switch", () => { invalidate(); });
  pi.on("session_before_fork", () => { invalidate(); });
  pi.on("session_before_tree", () => { invalidate(); });
  pi.on("session_tree", async (_event, ctx) => {
    invalidate();
    try { state = restoreState(ctx.sessionManager.getBranch()); errorState = undefined; await reconcileDraft(ctx); }
    catch (error) { errorState = String(error); ctx.ui.notify(errorState, "error"); }
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { invalidate(); sessionId = ""; ctx.ui.setStatus("review-plan", undefined); });
}
