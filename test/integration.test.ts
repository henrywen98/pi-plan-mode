import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { harness, call, text, sample } from "./harness.ts";
import { SUBMIT, STATE } from "../src/state.ts";

const submit = async (h: Awaited<ReturnType<typeof harness>>) => { h.frames.push([call(SUBMIT, { plan: sample })]); await h.prompt("Prepare the plan."); };

test("real Pi tools: direct and codemode writes blocked; read, bash, MCP and discovery run", async () => {
  const h = await harness();
  try {
    const file = join(h.cwd, "input.txt"), blocked = join(h.cwd, "blocked.txt");
    await writeFile(file, "before");
    const tools = h.session.getActiveToolNames().sort();
    await h.prompt("/plan start");
    h.frames.push([
      call("write", { path: blocked, content: "bad" }),
      call("edit", { path: file, edits: [{ oldText: "before", newText: "bad" }] }),
      call("codemode", { code: `const results = await Promise.allSettled([tools.write({path:${JSON.stringify(blocked)},content:'bad'}),tools.edit({path:${JSON.stringify(file)},edits:[{oldText:'before',newText:'bad'}]}),tools.read({path:${JSON.stringify(file)}}),tools.bash({command:'printf SAFE'}),tools.mcp__fixture__read({})]); text(results);` }),
    ], [text("Probe complete.")]);
    await h.prompt("Run offline probes.");
    const denied = h.events.filter(e => e.type === "tool_execution_end" && ["edit", "write"].includes(e.toolName));
    assert.equal(denied.length, 4, JSON.stringify(h.notices));
    assert.ok(denied.every(e => e.isError));
    assert.equal(await readFile(file, "utf8"), "before");
    await assert.rejects(access(blocked));
    assert.ok(h.events.some(e => e.type === "tool_execution_end" && e.toolName === "mcp__fixture__read" && !e.isError));
    assert.deepEqual(h.session.getActiveToolNames().sort(), tools);
    await h.prompt("/plan exit");
    h.frames.push([call("write", { path: blocked, content: "approved elsewhere" })], [text("Done.")]);
    await h.prompt("Write now outside plan mode.");
    assert.equal(await readFile(blocked, "utf8"), "approved elsewhere");
  } finally { await h.close(); }
});

test("submit, cancel, feedback and resubmit; no accidental approval or repeated menu", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start");
    await submit(h);
    assert.equal(h.state().mode, "ready", JSON.stringify(h.notices));
    assert.equal(h.menus.length, 1, JSON.stringify(h.notices));
    const path = h.state().proposal!.path;
    assert.equal(await readFile(path, "utf8"), sample);
    assert.equal(h.state().approved, undefined);
    const calls = h.requests.length;
    await h.session.reload();
    assert.equal(h.state().mode, "ready");
    assert.equal(h.menus.length, 1);
    assert.equal(h.requests.length, calls);
    h.frames.push([text("Clarifying only.")]);
    await h.prompt("可以，先解释一下。");
    assert.equal(h.state().mode, "planning");
    await h.prompt("/plan implement");
    assert.equal(h.state().approved, undefined);
    assert.ok(h.notices.some(n => /No complete plan is ready for approval/.test(n.message)));
    await submit(h);
    assert.equal(h.menus.length, 2);
    assert.equal(h.state().proposal!.path, path, "Revisions reuse the current plan file.");
    await h.prompt("/plan exit");
    assert.equal(await readFile(path, "utf8"), sample);
  } finally { await h.close(); }
});

test("same-session approval executes a frozen plan; later draft changes do not affect it", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    const draft = h.state().proposal!.path;
    h.confirm(true);
    h.frames.push([call("write", { path: join(h.cwd, "result.txt"), content: "OK" })], [text("Verified OK.")]);
    await h.prompt("/plan implement"); await h.session.waitForIdle();
    assert.equal(h.state().mode, "off", JSON.stringify(h.notices));
    assert.ok(h.state().approved);
    await writeFile(draft, "# Changed later\n");
    assert.equal(await readFile(h.state().approved!.path, "utf8"), sample);
    assert.equal(await readFile(join(h.cwd, "result.txt"), "utf8"), "OK");
    assert.equal(h.session.model?.id, "scripted");
    assert.equal(h.session.thinkingLevel, "medium");
  } finally { await h.close(); }
});

test("rejected kickoff can be explicitly approved again after reload", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    const count = h.requests.length;
    const send = h.session.sendUserMessage.bind(h.session);
    h.session.sendUserMessage = async () => { throw new Error("Injected asynchronous kickoff rejection"); };
    h.confirm(true); await h.prompt("/plan implement");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, count);
    assert.equal(h.state().mode, "ready", "Failed kickoff must remain reviewable.");
    h.session.sendUserMessage = send;
    const menus = h.menus.length;
    await h.session.reload();
    assert.equal(h.requests.length, count, "Reload must not retry automatically.");
    assert.equal(h.menus.length, menus, "Reload must not reopen an old menu.");
    h.confirm(false); await h.prompt("/plan implement");
    assert.equal(h.requests.length, count, "Retry still requires approval.");
    h.confirm(true);
    h.frames.push([call("write", { path: join(h.cwd, "retry.txt"), content: "OK" })], [text("Retry complete.")]);
    await h.prompt("/plan implement"); await h.session.waitForIdle();
    assert.equal(await readFile(join(h.cwd, "retry.txt"), "utf8"), "OK");
    assert.equal(h.state().mode, "off");
  } finally { await h.close(); }
});

test("changes during review prevent approval", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    h.choose(async items => { await writeFile(h.state().proposal!.path, "# Changed during review\n"); return items[0]; });
    await h.prompt("/plan");
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().approved, undefined);
    assert.ok(h.notices.some(n => /Plan changed/.test(n.message)), JSON.stringify(h.notices));
  } finally { await h.close(); }
});

test("fresh-session handoff preserves runtime and project rules, without planning history", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start");
    h.frames.push([text("PLANNING_HISTORY_SENTINEL")]); await h.prompt("Investigate first.");
    await submit(h);
    const oldId = h.session.sessionId, oldFile = h.session.sessionFile;
    await h.session.setModel(h.runtime.services.modelRuntime.getModel("fixture", "alternate")!);
    h.session.setThinkingLevel("high");
    h.confirm(true);
    h.frames.push([call("write", { path: join(h.cwd, "fresh.txt"), content: "OK" })], [text("Verified fresh.")]);
    await h.prompt("/plan fresh");
    assert.notEqual(h.session.sessionId, oldId, JSON.stringify(h.notices));
    assert.equal(h.session.sessionManager.getHeader()?.parentSession, oldFile);
    assert.equal(h.session.model?.id, "alternate", JSON.stringify(h.notices));
    assert.equal(h.session.thinkingLevel, "high");
    assert.equal(h.session.sessionManager.getCwd(), h.cwd);
    assert.equal(h.state().mode, "off");
    assert.equal(h.state().pendingRuntime, undefined);
    assert.doesNotMatch(JSON.stringify(h.session.messages), /PLANNING_HISTORY_SENTINEL/);
    assert.match(JSON.stringify(h.requests.at(-1)), /PROJECT_RULE_SENTINEL/);
    assert.equal(await readFile(join(h.cwd, "fresh.txt"), "utf8"), "OK");
  } finally { await h.close(); }
});

test("cancelled fresh session leaves the original ready plan", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    const id = h.session.sessionId;
    h.cancelSwitch(true); h.confirm(true);
    await h.prompt("/plan fresh");
    assert.equal(h.session.sessionId, id);
    assert.equal(h.state().mode, "ready", JSON.stringify(h.notices));
  } finally { await h.close(); }
});

test("compaction and real tree navigation restore branch-owned state", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start");
    h.frames.push([text("Explored. " + "Earlier investigation. ".repeat(1000))]); await h.prompt("Inspect.");
    const branchPoint = h.session.sessionManager.getLeafId()!;
    await submit(h);
    const readyPath = h.state().proposal!.path;
    await h.session.compact();
    assert.equal(h.state().mode, "ready");
    h.frames.push([text("Still planning.")]); await h.prompt("Explain.");
    assert.match(JSON.stringify(h.requests.at(-1)), /PLAN MODE — PLANNING/);
    await h.session.navigateTree(branchPoint, { summarize: false });
    assert.equal(h.state().mode, "planning");
    assert.equal(h.state().proposal, undefined);
    await access(readyPath);
    assert.equal(h.session.sessionManager.getBranch().some((e: any) => e.customType === STATE), true);
  } finally { await h.close(); }
});

test("queued feedback supersedes submission before automatic approval", async () => {
  const h = await harness([pi => {
    pi.on("tool_execution_end", event => {
      if (event.toolName === SUBMIT && !event.isError) pi.sendUserMessage("Clarify the proposal.", { deliverAs: "followUp" });
    });
  }]);
  try {
    await h.prompt("/plan start");
    await submit(h);
    await h.session.waitForIdle();
    assert.equal(h.state().mode, "planning");
    assert.equal(h.menus.length, 0);
  } finally { await h.close(); }
});

test("feedback while a menu is open invalidates its approval", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    h.choose(async items => { await h.prompt("Changed requirement."); return items[0]; });
    await h.prompt("/plan");
    assert.equal(h.state().mode, "planning");
    assert.equal(h.state().approved, undefined);
  } finally { await h.close(); }
});

test("invalid draft and unavailable model do not approve or start requests", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    const count = h.requests.length;
    await writeFile(h.state().proposal!.path, "");
    await h.prompt("/plan");
    assert.equal(h.state().approved, undefined);
    assert.equal(h.requests.length, count);
    await writeFile(h.state().proposal!.path, sample);
    h.runtime.services.modelRuntime.unregisterProvider("fixture");
    h.confirm(true); await h.prompt("/plan implement");
    assert.equal(h.state().mode, "ready");
    assert.equal(h.requests.length, count);
  } finally { await h.close(); }
});

test("missing authentication stops approval without switching models", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    const runtime = h.runtime.services.modelRuntime;
    const config = runtime.getRegisteredProviderConfig("fixture") as any;
    runtime.unregisterProvider("fixture");
    runtime.registerProvider("fixture", { ...config, apiKey: undefined, authHeader: true });
    await runtime.refresh({ allowNetwork: false });
    const count = h.requests.length;
    h.confirm(true); await h.prompt("/plan implement");
    assert.equal(h.state().mode, "ready", JSON.stringify(h.notices));
    assert.equal(h.requests.length, count);
    assert.equal(h.session.model?.provider, "fixture");
  } finally { await h.close(); }
});

test("runtime mismatch after replacement stops kickoff", async () => {
  const h = await harness([pi => { pi.on("session_start", (_e, ctx) => {
    if (ctx.sessionManager.getHeader()?.parentSession) pi.setThinkingLevel("low");
  }); }]);
  try {
    await h.prompt("/plan start"); await submit(h);
    const count = h.requests.length;
    h.confirm(true); await h.prompt("/plan fresh");
    assert.equal(h.requests.length, count);
    assert.ok(h.notices.some(n => /runtime settings did not match/.test(n.message)));
  } finally { await h.close(); }
});

test("source session can retry after a fresh-session runtime mismatch", async () => {
  let mismatch = true;
  const h = await harness([pi => { pi.on("session_start", (_event, ctx) => {
    if (mismatch && ctx.sessionManager.getHeader()?.parentSession) pi.setThinkingLevel("low");
  }); }]);
  try {
    await h.prompt("/plan start"); await submit(h);
    const source = h.session.sessionFile!;
    const count = h.requests.length;
    h.confirm(true); await h.prompt("/plan fresh");
    assert.equal(h.requests.length, count, "The mismatched session must not execute.");
    const menus = h.menus.length;
    await h.runtime.switchSession(source);
    assert.equal(h.state().mode, "ready", "The source must retain its reviewable proposal.");
    assert.equal(h.requests.length, count);
    assert.equal(h.menus.length, menus, "Returning must not reopen approval automatically.");
    mismatch = false;
    h.frames.push([call("write", { path: join(h.cwd, "fresh-retry.txt"), content: "OK" })], [text("Fresh retry complete.")]);
    await h.prompt("/plan fresh");
    assert.equal(await readFile(join(h.cwd, "fresh-retry.txt"), "utf8"), "OK");
    assert.equal(h.session.sessionManager.getHeader()?.parentSession, source);
    assert.equal(h.state().mode, "off");
  } finally { await h.close(); }
});

test("export never overwrites an existing file", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    await h.prompt("/plan export plan.md");
    assert.equal(await readFile(join(h.cwd, "plan.md"), "utf8"), sample);
    await writeFile(join(h.cwd, "plan.md"), "KEEP");
    await h.prompt("/plan export plan.md");
    assert.equal(await readFile(join(h.cwd, "plan.md"), "utf8"), "KEEP");
    assert.equal(h.state().mode, "ready");
  } finally { await h.close(); }
});

test("completion cannot run in normal mode or beside another tool", async () => {
  const h = await harness();
  try {
    h.frames.push([call(SUBMIT, { plan: sample })], [text("Rejected.")]); await h.prompt("Submit without entering.");
    assert.equal(h.state().proposal, undefined);
    await h.prompt("/plan start");
    h.frames.push([call(SUBMIT, { plan: sample }), call("read", { path: join(h.cwd, "AGENTS.md") })], [text("Rejected mixed batch.")]);
    await h.prompt("Mixed submission.");
    assert.equal(h.state().proposal, undefined);
  } finally { await h.close(); }
});
