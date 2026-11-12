import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, createCodemodeExtension, createToolSearchExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import planMode from "../index.ts";
import { restoreState } from "../src/state.ts";

export const text = (value: string) => ({ type: "text", text: value });
export const call = (name: string, args: unknown) => ({ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args });
export const sample = "# Reviewable plan\n\n## 1. Goal and scope\nCreate one local result.\n\n## 2. Acceptance and verification\nThe result contains OK. Read it and keep the output.\n\n## 3. Approach\nWrite the result after approval.\n\n## 4. Assumptions and stop conditions\nThe local directory is writable. Stop if it is not.\n\n## 5. Deliverables and references\nThe result file.\n";

/** Synthetic events only: no remote server, credentials, or model requests. */
export function responseStream(model: any, content: any[]) {
  const stream = createAssistantMessageEventStream();
  const message: any = { role: "assistant", content, provider: model.provider, model: model.id, api: model.api,
    stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: "start", partial: message });
  content.forEach((block, i) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex: i, partial: message });
      stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
    } else {
      stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
    }
  });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
  return stream;
}

export async function harness(extra: ExtensionFactory[] = []) {
  const root = await mkdtemp(join(tmpdir(), "review-plan-test-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT_RULE_SENTINEL: Never contact production.\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const frames: any[][] = [], requests: any[] = [], events: any[] = [], notices: any[] = [], menus: any[] = [];
  let select: (items: string[]) => Promise<string | undefined> = async () => undefined;
  let confirm: () => Promise<boolean> = async () => false;
  let cancelSwitch = false;
  let reviewFeedback: string | undefined;
  const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:1",
    models: ["scripted", "alternate"].map(id => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
    streamSimple: (model: any, context: any) => { requests.push(structuredClone(context)); return responseStream(model, frames.shift() ?? [text("Finished.")]); } });
  await models.refresh({ allowNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "scripted", defaultThinkingLevel: "medium", defaultTools: ["+codemode", "+tool_search"], compaction: { enabled: false, keepRecentTokens: 256, reserveTokens: 256 }, retry: { enabled: false } });
  const probe: ExtensionFactory = pi => {
    pi.on("session_before_switch", () => cancelSwitch ? { cancel: true } : undefined);
    pi.on("session_before_compact", (event: any) => ({ compaction: { summary: "Offline compacted summary.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 10 } }));
    pi.registerTool({ name: "mcp__fixture__read", exposure: "codemode", label: "Fixture read", description: "Read local fixture", parameters: { type: "object", properties: {} } as any, execute: async () => ({ content: [text("fixture-data")] as any, details: {} }) });
  };
  const factory = async (options: any) => {
    const services = await createAgentSessionServices({ cwd: options.cwd, agentDir, modelRuntime: models, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), planMode, probe, ...extra] } });
    const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent,
      model: models.getModel("fixture", "scripted"), thinkingLevel: "medium" });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) });
  const ui: any = new Proxy({
    select: async (title: string, items: string[], options: any) => {
      menus.push({ title, items });
      if (options?.signal?.aborted) return undefined;
      return select(items);
    },
    custom: async () => {
      const items = ["Execute in current session", "Execute in fresh session", "Revise"];
      menus.push({ title: "Approve this plan? Esc closes", items });
      const choice = await select(items);
      if (!choice) return undefined;
      const feedback = reviewFeedback;
      reviewFeedback = undefined;
      return { action: ["here", "fresh", "revise"][items.indexOf(choice)], feedback };
    },
    confirm: async () => confirm(), notify: (message: string, type: string) => notices.push({ message, type }),
    setStatus: () => {}, theme: { fg: (_: string, value: string) => value },
  }, { get(target, key) { return (target as any)[key] ?? (() => undefined); } });
  const bind = async (session: any) => {
    session.subscribe((event: any) => events.push(event));
    await session.bindExtensions({ uiContext: ui, mode: "tui", onError: (e: any) => notices.push({ type: "extension-error", message: e.error }),
      commandContextActions: { waitForIdle: () => session.waitForIdle(), newSession: (o: any) => runtime.newSession(o), fork: (id: string, o: any) => runtime.fork(id, o), switchSession: (p: string, o: any) => runtime.switchSession(p, o), navigateTree: (id: string, o: any) => session.navigateTree(id, o), reload: () => session.reload() } });
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return { root, cwd, agentDir, runtime, frames, requests, events, notices, menus,
    get session() { return runtime.session; },
    state: () => restoreState(runtime.session.sessionManager.getBranch()),
    choose: (value?: string | ((items: string[]) => Promise<string | undefined>)) => { select = typeof value === "function" ? value : async () => value; },
    revise: (feedback?: string) => {
      reviewFeedback = feedback;
      select = async items => { select = async () => undefined; return items[2]; };
    },
    confirm: (value: boolean) => { confirm = async () => value; },
    cancelSwitch: (value: boolean) => { cancelSwitch = value; },
    prompt: (message: string) => runtime.session.prompt(message),
    close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
