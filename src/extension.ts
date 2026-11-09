import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PlanFiles, digest, normalizePlan, titleOf, MAX_BYTES } from "./files.ts";
import { CONTEXT, REVIEW, STATE, SUBMIT, emptyState, planning, restoreState, type PlanState, type PlanRef } from "./state.ts";
import { kickoff, offPrompt, planPrompt } from "./prompts.ts";

export default function planMode(pi: ExtensionAPI) {
  const files = new PlanFiles(join(getAgentDir(), "plans"));
  let state = emptyState();
  let generation = 0;
  let sessionId = "";
  let menuAbort: AbortController | undefined;
  let autoToken: string | undefined;
  let reviewing = false;
  let errorState: string | undefined;

  function invalidate() {
    generation++;
    autoToken = undefined;
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
    save({ ...emptyState(), workflow: randomUUID(), mode: "planning", approved: state.approved }, ctx);
    ctx.ui.notify("已进入规划。正常探测保留；edit/write 暂停。", "info");
  }
  function exit(ctx: ExtensionContext) {
    assertUsable(ctx);
    invalidate();
    save({ ...state, mode: "off", pendingRuntime: undefined }, ctx);
    ctx.ui.notify("已退出规划；计划文件保留，未启动执行。", "info");
  }
  function display(body: string, ref: PlanRef, label: string) {
    pi.appendEntry(REVIEW, { body, path: ref.path, hash: digest(body), label });
  }
  async function show(ctx: ExtensionContext) {
    const ref = state.mode === "off" && state.approved ? state.approved : state.proposal ?? state.approved;
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
    const next: PlanState = { ...state, mode: "off", approved, pendingRuntime: undefined, handoffError: undefined };
    save(next, ctx);
    if (destination === "here") {
      try { pi.sendUserMessage(request); }
      catch (error) {
        if (sessionId === id && state === next) save(s, ctx);
        throw error;
      }
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
      const choices = ["当前会话执行", "清空上下文后执行", "继续修改"];
      let choice: string | undefined;
      if (destination) {
        const yes = await ctx.ui.confirm("执行刚展示的计划？", destination === "fresh" ? "保留旧会话，在关联新会话执行。" : "在当前会话执行。", { signal: controller.signal });
        choice = yes ? choices[destination === "here" ? 0 : 1] : undefined;
      } else {
        choice = await ctx.ui.select("批准这一版计划？Esc 仅关闭", choices, { signal: controller.signal });
      }
      if (controller.signal.aborted || !valid(g, s, id)) return;
      if (choice === choices[2]) {
        invalidate();
        save({ ...state, mode: "planning" }, ctx);
        ctx.ui.notify("继续讨论；重新提交完整计划后再审批。", "info");
      } else if (choice === choices[0] || choice === choices[1]) {
        await approve(ctx, body, ref, choice === choices[0] ? "here" : "fresh", g, s, id);
      }
    } finally {
      if (menuAbort === controller) menuAbort = undefined;
      reviewing = false;
    }
  }

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
          const ref = state.mode === "off" && state.approved ? state.approved : state.proposal ?? state.approved;
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
    description: "Submit a complete Markdown plan for review only while /plan is active. Does not approve or execute. Call alone as the final action. Limit: 50,000 UTF-8 bytes.",
    parameters: Type.Object({ plan: Type.String({ minLength: 1, maxLength: MAX_BYTES }) }),
    async execute(_callId, params, signal, _update, ctx) {
      if (errorState || !planning(state)) throw new Error("plan_submit is only available in active Plan mode.");
      const body = normalizePlan(params.plan);
      const s = state, g = generation, id = sessionId;
      const ref = await files.create(body);
      signal?.throwIfAborted();
      if (!valid(g, s, id)) throw new Error("Planning changed during submission. This proposal was not activated.");
      save({ ...state, mode: "ready", proposal: ref, shown: undefined }, ctx);
      return { content: [{ type: "text" as const, text: `计划已保存，等待用户审批：${ref.path}` }], details: { ref }, terminate: true };
    },
    renderCall: args => new Text(`提交计划 · ${typeof args.plan === "string" ? titleOf(args.plan) : "Markdown"}`, 0, 0),
    renderResult: result => new Text(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0),
  });
  pi.registerEntryRenderer(REVIEW, entry => {
    const d = entry.data as { body: string; label: string; path: string };
    return new Markdown(`**${d.label}**\n\n${d.body}\n\n文件：\`${d.path}\``, 0, 0, getMarkdownTheme());
  });

  pi.on("tool_call", (event, ctx) => {
    if ((planning(state) || errorState) && (event.toolName === "edit" || event.toolName === "write")) {
      return { block: true, reason: "Plan mode blocks edit/write until explicit user approval. Do not use another tool to implement early." };
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
  pi.on("input", (_event, ctx) => {
    invalidate();
    if (state.mode === "ready") save({ ...state, mode: "planning" }, ctx);
  });
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter((m: any) => !(m.role === "custom" && m.customType === CONTEXT));
    if (!state.workflow && !errorState) return { messages };
    const content = planning(state) || errorState ? planPrompt(ctx.hasUI && pi.getActiveTools().includes("ask_user_question")) : offPrompt;
    messages.push({ role: "custom", customType: CONTEXT, content, display: false, timestamp: 0 });
    return { messages };
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (state.mode !== "ready" || !state.proposal || state.shown === state.proposal.id || !ctx.hasUI || ctx.hasPendingMessages()) return;
    save({ ...state, shown: state.proposal.id }, ctx);
    autoToken = randomUUID();
    pi.sendUserMessage(`/plan __review ${autoToken}`, { expandPromptTemplates: true });
  });
  pi.on("session_start", async (_event, ctx) => {
    invalidate();
    sessionId = ctx.sessionManager.getSessionId();
    try {
      state = restoreState(ctx.sessionManager.getBranch());
      errorState = undefined;
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
  pi.on("session_tree", (_event, ctx) => {
    invalidate();
    try { state = restoreState(ctx.sessionManager.getBranch()); errorState = undefined; }
    catch (error) { errorState = String(error); ctx.ui.notify(errorState, "error"); }
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { invalidate(); sessionId = ""; ctx.ui.setStatus("review-plan", undefined); });
}
