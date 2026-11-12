import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { harness, call, sample, text } from "./harness.ts";
import { SUBMIT } from "../src/state.ts";
import { kickoff } from "../src/prompts.ts";

async function ready(h: Awaited<ReturnType<typeof harness>>) {
  await h.prompt("/plan start");
  h.frames.push([call(SUBMIT, { plan: sample })]); await h.prompt("Prepare a plan.");
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Expected inline feedback was not dispatched");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const asText = (m: any) => typeof m.content === "string" ? m.content : m.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";

test("review feedback: empty Enter keeps the existing continue-editing behavior", async () => {
  const h = await harness();
  try {
    await ready(h); const count = h.requests.length, path = h.state().proposal!.path;
    h.revise(); await h.prompt("/plan");
    assert.equal(h.state().mode, "planning");
    assert.equal(h.requests.length, count);
    assert.equal(h.state().approved, undefined);
    assert.equal(await readFile(path, "utf8"), sample);
  } finally { await h.close(); }
});

test("review feedback: inline text dispatches once and updates the same plan without approving", async () => {
  const h = await harness();
  try {
    await ready(h); const path = h.state().proposal!.path;
    const feedback = "把标题改成 Smaller plan，其他内容保留。";
    h.revise(feedback);
    h.frames.push([call("edit", { path, edits: [{ oldText: "# Reviewable plan", newText: "# Smaller plan" }] })], [call(SUBMIT, {})]);
    const count = h.requests.length;
    await h.prompt("/plan");
    await waitFor(() => h.requests.length > count);
    await h.session.waitForIdle();
    assert.equal(h.state().mode, "ready");
    assert.equal(h.state().proposal!.path, path);
    assert.equal(await readFile(path, "utf8"), sample.replace("# Reviewable plan", "# Smaller plan"));
    assert.equal(h.state().approved, undefined);
    const messages = h.session.messages.filter((m: any) => m.role === "user" && asText(m).includes(feedback));
    assert.equal(messages.length, 1);
    assert.match(asText(messages[0]), /Please revise the current plan/);
    assert.match(asText(messages[0]), /without executing/);
  } finally { await h.close(); }
});

test("review feedback: a stale menu does not send captured text", async () => {
  const h = await harness();
  try {
    await ready(h);
    h.revise("未发送的旧反馈");
    h.choose(async items => { h.frames.push([text("New feedback already processed.")]); await h.prompt("A newer requirement."); return items[2]; });
    const count = h.requests.length;
    await h.prompt("/plan");
    assert.equal(h.requests.length, count + 1);
    assert.ok(!h.session.messages.some((m: any) => m.role === "user" && asText(m).includes("未发送的旧反馈")));
    assert.equal(h.state().mode, "planning");
    assert.equal(h.state().approved, undefined);
  } finally { await h.close(); }
});

test("review feedback: pasted execution text remains feedback, not a new approval", async () => {
  const h = await harness();
  try {
    await ready(h); h.confirm(true); h.frames.push([text("Execution fixture completed.")]);
    await h.prompt("/plan implement"); await waitFor(() => h.state().mode === "off"); await h.session.waitForIdle();
    const approved = h.state().approved!;
    await h.prompt("/plan start"); h.frames.push([call(SUBMIT, {})]); await h.prompt("Review again.");
    const markers = h.session.sessionManager.getBranch().filter((e: any) => e.customType === "review-plan-handoff-v1").length;
    h.revise(kickoff(approved, sample)); h.frames.push([text("Only revising the plan.")]);
    const count = h.requests.length; await h.prompt("/plan"); await waitFor(() => h.requests.length > count); await h.session.waitForIdle();
    assert.equal(h.state().mode, "planning");
    assert.equal(h.state().approved!.id, approved.id);
    assert.equal(h.session.sessionManager.getBranch().filter((e: any) => e.customType === "review-plan-handoff-v1").length, markers);
    const user = h.session.messages.findLast((m: any) => m.role === "user");
    assert.ok(asText(user).startsWith("Please revise the current plan without executing"));
  } finally { await h.close(); }
});

test("review feedback: whitespace sends no request and revision can repair a manual draft edit", async () => {
  const h = await harness();
  try {
    await ready(h); const path = h.state().proposal!.path, count = h.requests.length;
    await writeFile(path, sample.replace("# Reviewable plan", "# Manual plan"));
    h.revise("   "); await h.prompt("/plan");
    assert.equal(h.requests.length, count);
    assert.equal(h.state().mode, "planning");
    assert.equal(h.state().proposal!.path, path);
  } finally { await h.close(); }
});
