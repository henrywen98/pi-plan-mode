import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, symlink, unlink, link } from "node:fs/promises";
import { join, relative } from "node:path";
import { harness, call, text, sample } from "./harness.ts";
import { SUBMIT, REVIEW } from "../src/state.ts";
import { kickoff, planPrompt } from "../src/prompts.ts";
import { digest } from "../src/files.ts";

type Harness = Awaited<ReturnType<typeof harness>>;
const revised = sample.replace("# Reviewable plan", "# Revised plan");
async function submit(h: Harness, plan?: string) {
  h.frames.push([call(SUBMIT, plan === undefined ? {} : { plan })]);
  await h.prompt("Review the current plan.");
}
async function executed(h: Harness, path: string) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { if (await readFile(path, "utf8") === "OK") break; }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() > deadline) throw new Error("Approved execution did not finish");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await h.session.waitForIdle();
}

test("current plan: resubmission and re-entry reuse one draft", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const first = h.state().proposal!;
    await submit(h, revised);
    assert.equal(h.state().proposal!.path, first.path);
    assert.equal(h.state().proposal!.id, first.id);
    assert.equal(await readFile(first.path, "utf8"), revised);
    assert.equal(h.menus.length, 2);
    await h.prompt("/plan exit"); await h.prompt("/plan start");
    assert.equal(h.state().proposal!.path, first.path);
    assert.equal(h.state().mode, "planning");
    await submit(h);
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().proposal!.hash, digest(revised));
    assert.equal((await readdir(join(h.agentDir, "plans"))).filter(p => p.endsWith(".draft.md")).length, 1);
  } finally { await h.close(); }
});

test("current plan: direct and nested edits work only on its draft", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const draft = h.state().proposal!.path, outside = join(h.cwd, "source.txt");
    await writeFile(outside, "KEEP");
    h.frames.push([call("edit", { path: draft, edits: [{ oldText: "# Reviewable plan", newText: "# Revised plan" }] })], [text("Edited.")]);
    await h.prompt("Revise the plan title.");
    assert.equal(await readFile(draft, "utf8"), revised);
    assert.equal(h.state().mode, "planning");
    const before = h.events.length;
    h.frames.push([call("codemode", { code: `text(await Promise.allSettled([
      tools.write({path:${JSON.stringify(relative(h.cwd, draft))},content:${JSON.stringify(sample)}}),
      tools.edit({path:${JSON.stringify(outside)},edits:[{oldText:'KEEP',newText:'BAD'}]}),
      tools.write({path:${JSON.stringify(join(h.agentDir, "plans", "plan-other.draft.md"))},content:'BAD'})]));` })], [text("Probed.")]);
    await h.prompt("Check the current draft boundary.");
    const ends = h.events.slice(before).filter(e => e.type === "tool_execution_end" && ["edit", "write"].includes(e.toolName));
    assert.equal(ends.filter(e => !e.isError).length, 1);
    assert.equal(ends.filter(e => e.isError).length, 2);
    assert.equal(await readFile(outside, "utf8"), "KEEP");
    assert.equal(await readFile(draft, "utf8"), sample);
    h.frames.push([call("write", { path: draft, content: revised })],
      [call("codemode", { code: `text(await tools.edit({path:${JSON.stringify(draft)},edits:[{oldText:'# Revised plan',newText:'# Reviewable plan'}]}));` })], [text("Revised again.")]);
    await h.prompt("Check direct write and nested edit on this draft.");
    assert.equal(await readFile(draft, "utf8"), sample);
    assert.ok(h.events.slice(before).some(e => e.type === "tool_execution_end" && e.parentToolCallId && e.toolName === "edit" && !e.isError));
    await submit(h);
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().proposal!.path, draft);
    assert.match(JSON.stringify(h.requests.at(-1)), new RegExp(draft));
  } finally { await h.close(); }
});

test("current plan: show and export prefer B after approved A and exit", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    h.confirm(true);
    const result = join(h.cwd, "result.txt");
    h.frames.push([call("write", { path: result, content: "OK" })], [text("Done.")]);
    await h.prompt("/plan implement"); await executed(h, result);
    const approved = h.state().approved!, draft = h.state().proposal!.path;
    await h.prompt("/plan start"); await submit(h, revised);
    const requests = h.requests.length;
    await h.prompt("/plan exit"); await h.prompt("/plan show"); await h.prompt("/plan export selected.md");
    const shown: any = h.session.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === REVIEW);
    assert.equal(shown.data.body, revised);
    assert.equal(await readFile(join(h.cwd, "selected.md"), "utf8"), revised);
    assert.equal(h.state().proposal!.path, draft);
    assert.equal(await readFile(approved.path, "utf8"), sample);
    assert.equal(h.requests.length, requests);
    await h.session.reload(); await h.prompt("/plan export reloaded.md");
    assert.equal(await readFile(join(h.cwd, "reloaded.md"), "utf8"), revised);
  } finally { await h.close(); }
});

test("current plan: empty submission needs an existing valid file; invalid replacement preserves it", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h);
    assert.equal(h.state().proposal, undefined);
    await submit(h, sample);
    const draft = h.state().proposal!.path;
    await submit(h, "   ");
    assert.equal(await readFile(draft, "utf8"), sample);
    await writeFile(draft, ""); await submit(h);
    assert.equal(h.state().mode, "planning");
    h.frames.push([call("write", { path: draft, content: revised })], [text("Repaired.")]);
    await h.prompt("Repair this draft only.");
    assert.equal(await readFile(draft, "utf8"), revised);
    await submit(h);
    assert.equal(h.state().mode, "ready");
  } finally { await h.close(); }
});

test("current plan: approved files and linked draft targets remain protected", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    h.confirm(true); await h.prompt("/plan implement"); await h.session.waitForIdle();
    const approved = h.state().approved!, draft = h.state().proposal!.path;
    await h.prompt("/plan start");
    for (const kind of ["direct", "symlink", "hardlink"]) {
      if (kind !== "direct") {
        await unlink(draft);
        if (kind === "symlink") await symlink(approved.path, draft);
        else await link(approved.path, draft);
      }
      const path = kind === "direct" ? approved.path : draft;
      h.frames.push([call("write", { path, content: "BAD" })], [text("Blocked.")]);
      await h.prompt("Probe the write boundary.");
      assert.equal(await readFile(approved.path, "utf8"), sample);
      if (kind !== "direct") {
        await submit(h, revised);
        assert.equal(await readFile(approved.path, "utf8"), sample);
        assert.equal(h.state().mode, "planning");
      }
    }
  } finally { await h.close(); }
});

test("current plan: changed draft cannot revive old approval on reload or tree navigation", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const leaf = h.session.sessionManager.getLeafId()!, draft = h.state().proposal!.path;
    await writeFile(draft, revised);
    const count = h.requests.length, menus = h.menus.length;
    await h.session.reload();
    assert.equal(h.state().mode, "planning");
    assert.equal(h.requests.length, count); assert.equal(h.menus.length, menus);
    await submit(h);
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().proposal!.hash, digest(revised));
    await h.session.navigateTree(leaf, { summarize: false });
    assert.equal(h.state().mode, "planning");
    const requests = h.requests.length;
    h.confirm(true); await h.prompt("/plan implement");
    assert.equal(h.requests.length, requests);
    assert.equal(h.state().approved, undefined);
    assert.equal(await readFile(draft, "utf8"), revised);
  } finally { await h.close(); }
});

for (const destination of ["implement", "fresh"]) {
  test(`current plan: ${destination} handoff carries one body without mandatory reread`, async () => {
    const h = await harness();
    try {
      await h.prompt("/plan start"); await submit(h, sample);
      const draft = h.state().proposal!.path;
      const result = join(h.cwd, "result.txt");
      h.confirm(true);
      h.frames.push([call("write", { path: result, content: "OK" })], [text("Verified.")]);
      await h.prompt(`/plan ${destination}`); await executed(h, result);
      const messages = h.session.messages.filter((m: any) => m.role === "user");
      const request = JSON.stringify(messages.at(-1));
      assert.doesNotMatch(request, /first read the approved/i);
      assert.match(request, /without re-reading the plan file/);
      const user: any = messages.at(-1);
      const body = typeof user.content === "string" ? user.content : user.content.map((c: any) => c.text ?? "").join("");
      assert.equal(body.split(sample).length - 1, 1);
      await writeFile(draft, revised);
      assert.equal(await readFile(h.state().approved!.path, "utf8"), sample);
      assert.ok(!h.events.some(e => e.type === "tool_execution_start" && e.toolName === "read" && e.args.path === h.state().approved!.path));
    } finally { await h.close(); }
  });
}

test("current plan: reviewing a manual edit keeps the fresh source retryable", async () => {
  const h = await harness([pi => { pi.on("session_start", (_event, ctx) => {
    if (ctx.sessionManager.getHeader()?.parentSession) pi.setThinkingLevel("low");
  }); }]);
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const source = h.session.sessionFile!;
    await writeFile(h.state().proposal!.path, revised);
    h.confirm(true); await h.prompt("/plan fresh");
    await h.runtime.switchSession(source);
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().proposal!.hash, digest(revised));
    assert.equal(await readFile(h.state().approved!.path, "utf8"), revised);
  } finally { await h.close(); }
});

test("current plan: prompt permits incremental updates and handoff does not demand file hashing", () => {
  const prompt = planPrompt(true, "/plans/plan-current.draft.md");
  assert.match(prompt, /plan-current\.draft\.md/);
  assert.match(prompt, /Revise this single current plan/);
  assert.match(prompt, /plan_submit\(\{\}\)/);
  const body = kickoff({ id: "test", path: "/plans/plan-test.approved.md", title: "Plan", hash: digest(sample) }, sample);
  assert.doesNotMatch(body, /first read the approved/i);
  assert.match(body, /without re-reading the plan file/);
});
