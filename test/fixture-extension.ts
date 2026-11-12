// Offline test driver. It produces fixed events; it never calls a model or a network API.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const plan = `# 离线测试计划

## 1. 目标与范围
在当前临时目录生成 result.txt，不访问外部服务。

## 2. 验收标准与验证
文件内容必须是 OK。读取文件核对，保留测试记录。

## 3. 执行方案
用户批准后写入 result.txt，然后读取并核对。

## 4. 假设与停点
临时目录可写。若不可写，暂停，不改用其他目录。

## 5. 交付物与参考
交付 result.txt 和验证结果。范围或验收标准变化时先暂停确认。
`;
export default function fixture(pi: ExtensionAPI) {
  let blockKickoff = false;
  let currentPlan: string | undefined;
  let tracePath: string | undefined;
  let traceSession: string | undefined;
  pi.on("context", (_event, ctx) => {
    const entry: any = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "review-plan-state-v1");
    currentPlan = entry?.data?.proposal?.path;
  });
  pi.registerCommand("fixture-block-kickoff", { description: "Offline test only", handler: async (_args, ctx) => {
    blockKickoff = true;
    ctx.ui.notify("OFFLINE_KICKOFF_BLOCK_ARMED", "info");
  } });
  pi.on("input", (event, ctx) => {
    if (blockKickoff && event.source === "extension" && event.text.startsWith("Plan mode has ended.")) {
      blockKickoff = false;
      ctx.ui.notify("OFFLINE_KICKOFF_BLOCKED", "info");
      return { action: "handled" };
    }
  });
  pi.registerCommand("fixture-mismatch", { description: "Offline test only", handler: async (_args, ctx) => {
    writeFileSync(join(ctx.cwd, ".fixture-mismatch"), "once");
    ctx.ui.notify("OFFLINE_MISMATCH_ARMED", "info");
  } });
  pi.on("session_start", (_event, ctx) => {
    tracePath = join(ctx.cwd, ".fixture-requests.jsonl");
    traceSession = ctx.sessionManager.getSessionId();
    writeFileSync(join(ctx.cwd, ".fixture-session-id"), ctx.sessionManager.getSessionId());
    const flag = join(ctx.cwd, ".fixture-mismatch");
    if (ctx.sessionManager.getHeader()?.parentSession && existsSync(flag)) {
      unlinkSync(flag);
      pi.setThinkingLevel("low");
    }
  });
  pi.registerCommand("fixture-return", { description: "Offline test only", handler: async (_args, ctx) => {
    const parent = ctx.sessionManager.getHeader()?.parentSession;
    if (parent) await ctx.switchSession(parent);
  } });
  pi.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture",
    models: [{ id: "scripted", name: "Offline scripted fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    streamSimple(model: any, context: any) {
      if (tracePath) appendFileSync(tracePath, JSON.stringify({ session: traceSession, messages: context.messages }) + "\n");
      const asText = (m: any) => typeof m?.content === "string" ? m.content : m?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
      const last = context.messages.findLast((m: any) => !asText(m).includes("[PLAN MODE —"));
      const user = context.messages.findLast((m: any) => m.role === "user" && !asText(m).includes("[PLAN MODE —"));
      const query = asText(user);
      let content: any[];
      const tool = (name: string, args: unknown) => [{ type: "toolCall", name, arguments: args, id: `fixture_${Date.now()}` }];
      if (last?.role === "toolResult") {
        if (last.toolName === "edit" && !last.isError && query.includes("inline-feedback")) content = tool("read", { path: currentPlan });
        else if (last.toolName === "read" && !last.isError && query.includes("inline-feedback")) content = tool("plan_submit", {});
        else if (last.toolName === "edit" && !last.isError && query.includes("reviseplan")) content = tool("plan_submit", {});
        else if (last.toolName === "write" && !last.isError) content = tool("read", { path: "result.txt" });
        else content = [{ type: "text", text: query.startsWith("Plan mode has ended.") ? "EXECUTION_COMPLETE" : "QUESTION_COMPLETE" }];
      } else if (query.startsWith("Plan mode has ended.")) content = tool("write", { path: "result.txt", content: "OK" });
      else if (query.includes("show question")) content = tool("ask_user_question", { questions: [{ header: "Choice", question: "Which output should we use?", options: [{ label: "Alpha", description: "Use the first example." }, { label: "Beta", description: "Use the second example." }] }] });
      else if (query.includes("inline-feedback") && currentPlan) content = tool("edit", { path: currentPlan, edits: [{ oldText: "文件内容必须是 OK。", newText: "文件内容必须是 OK，并保留逐项核对记录。" }] });
      else if (query.includes("reviseplan") && currentPlan) content = tool("edit", { path: currentPlan, edits: [{ oldText: "# 离线测试计划", newText: "# 离线修订计划" }] });
      else if (query.includes("submitfile")) content = tool("plan_submit", {});
      else if (query.includes("prepareplan")) content = tool("plan_submit", { plan });
      else content = [{ type: "text", text: "OFFLINE_READY" }];
      const output: any = { role: "assistant", content, provider: model.provider, model: model.id, api: model.api,
        stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: output });
      content.forEach((block, contentIndex) => {
        if (block.type === "text") {
          stream.push({ type: "text_start", contentIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else {
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }
      });
      stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(); return stream;
    },
  });
}
