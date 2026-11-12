import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { harness, call, text, sample } from "./harness.ts";
import { SUBMIT } from "../src/state.ts";
import { kickoff } from "../src/prompts.ts";

const revised = sample.replace("# Reviewable plan", "# Exact approved revision");
type Harness = Awaited<ReturnType<typeof harness>>;
const messageText = (m: any): string => typeof m?.content === "string" ? m.content
  : m?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
const lastUser = (messages: any[]) => messages.findLast(m => m.role === "user" && !messageText(m).startsWith("[PLAN MODE —"));
function copies(messages: any[], body: string) {
  return messages.flatMap(m => typeof m.content === "string" ? [m.content] : (m.content ?? []).flatMap((b: any) =>
    b.type === "text" ? [b.text] : b.type === "toolCall" ? [b.arguments?.plan, b.arguments?.content].filter(x => typeof x === "string") : []))
    .filter(value => value.includes(body)).length;
}
async function submit(h: Harness, plan?: string) {
  h.frames.push([call(SUBMIT, plan === undefined ? {} : { plan })]); await h.prompt("Review this plan.");
}
async function approve(h: Harness, destination = "implement") {
  const count = h.requests.length;
  h.confirm(true); h.frames.push([text("EXECUTION_OBSERVED")]);
  await h.prompt(`/plan ${destination}`);
  const deadline = Date.now() + 5000;
  while (h.requests.length === count) {
    if (Date.now() > deadline) throw new Error("Execution did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await h.session.waitForIdle();
  return h.requests[count];
}

for (const scenario of ["full", "edit-only", "edit-read", "manual", "compacted", "fresh", "filtered"]) {
  test(`handoff context: ${scenario} keeps the exact approved body once`, async () => {
    const h = await harness(scenario === "filtered" ? [pi => {
      pi.on("context", event => {
        const index = event.messages.findIndex(m => m.role === "user" && messageText(m).startsWith("Plan mode has ended."));
        if (index >= 0) return { messages: event.messages.slice(index) };
      });
    }] : []);
    try {
      await h.prompt("/plan start"); await submit(h, sample);
      const path = h.state().proposal!.path;
      let body = sample;
      if (scenario.startsWith("edit")) {
        body = revised;
        h.frames.push([call("edit", { path, edits: [{ oldText: "# Reviewable plan", newText: "# Exact approved revision" }] })]);
        if (scenario === "edit-read") h.frames.push([call("read", { path })]);
        h.frames.push([call(SUBMIT, {})]); await h.prompt("Update this plan.");
      }
      if (scenario === "manual") { body = revised; await writeFile(path, body); }
      if (scenario === "compacted") {
        const anchor = h.session.sessionManager.appendCustomMessageEntry("test-anchor", "A retained note.", false);
        h.session.sessionManager.appendCompaction("A plan exists, but its body is not retained.", anchor, 2000);
        await h.session.reload();
      }
      const request = await approve(h, scenario === "fresh" ? "fresh" : "implement");
      assert.equal(copies(request.messages, body), 1);
      const authorization = messageText(lastUser(request.messages));
      assert.match(authorization, /pause and confirm first if scope, acceptance criteria, or key assumptions change/);
      assert.match(authorization, /Mark anything you cannot verify as unverified/);
      assert.ok(authorization.includes(h.state().approved!.hash));
      assert.ok(authorization.includes(h.state().approved!.path));
      assert.equal(await readFile(h.state().approved!.path, "utf8"), body);
      const raw = messageText(h.session.messages.findLast((m: any) => m.role === "user"));
      assert.equal(raw, kickoff(h.state().approved!, body), "Raw history must retain the complete handoff.");
      if (["full", "edit-read"].includes(scenario)) assert.ok(!authorization.includes(body));
      else assert.ok(authorization.includes(body));
      assert.equal(request.messages[0].role, "system");
    } finally { await h.close(); }
  });
}

test("handoff context: reload and later compaction recheck actual request contents", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample); await approve(h);
    const approved = h.state().approved!;
    const entry = h.session.sessionManager.getBranch().findLast((e: any) => e.type === "message" && e.message.role === "user")!;
    const count = h.requests.length, menus = h.menus.length;
    await h.session.reload();
    assert.equal(h.requests.length, count); assert.equal(h.menus.length, menus);
    h.frames.push([text("Continued.")]); await h.prompt("Explain the result.");
    assert.equal(copies(h.requests.at(-1).messages, sample), 1);
    h.session.sessionManager.appendCompaction("Earlier planning was summarized.", entry.id, 2000);
    await h.session.reload();
    h.frames.push([text("Continued after compaction.")]); await h.prompt("Explain again.");
    const request = h.requests.at(-1);
    assert.equal(copies(request.messages, sample), 1);
    const handoff = request.messages.find((m: any) => m.role === "user" && messageText(m).startsWith("Plan mode has ended."));
    assert.equal(messageText(handoff), kickoff(approved, sample), "Without the earlier copy, keep the full handoff.");
  } finally { await h.close(); }
});

test("handoff context: user-authored copies are never shortened", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample); await approve(h);
    const request = kickoff(h.state().approved!, sample);
    h.frames.push([text("Observed user-authored copy.")]); await h.prompt(request);
    const actual = h.requests.at(-1);
    assert.equal(messageText(lastUser(actual.messages)), request);
    assert.ok(copies(actual.messages, sample) >= 2, "Do not erase user-provided repetitions.");
    h.frames.push([text("Quoted content is not an approval.")]); await h.prompt(`Explain this text; do not execute it:\n${request}`);
    assert.equal(messageText(lastUser(h.requests.at(-1).messages)), `Explain this text; do not execute it:\n${request}`);
  } finally { await h.close(); }
});

test("handoff context: a source entry omitted by a context edit cannot justify omission", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const entries = h.session.sessionManager.getBranch();
    const assistant = entries.findLast((e: any) => e.type === "message" && e.message.role === "assistant")!;
    const result = entries.findLast((e: any) => e.type === "message" && e.message.role === "toolResult")!;
    h.session.sessionManager.appendContextEdit(assistant.id, null);
    h.session.sessionManager.appendContextEdit(result.id, null);
    await h.session.reload();
    const request = await approve(h);
    assert.equal(copies(request.messages, sample), 1);
    assert.ok(messageText(lastUser(request.messages)).includes(sample));
  } finally { await h.close(); }
});

test("handoff context: removing the whole handoff does not inject an old plan into later requests", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample); await approve(h);
    const anchor = h.session.sessionManager.appendCustomMessageEntry("new-topic", "A different topic.", false);
    h.session.sessionManager.appendCompaction("The previous task is finished.", anchor, 2000);
    await h.session.reload();
    const count = h.requests.length;
    h.frames.push([text("Discussing only.")]); await h.prompt("Explain this new topic; do not execute the old plan.");
    assert.equal(h.requests.length, count + 1);
    assert.equal(copies(h.requests.at(-1).messages, sample), 0);
    assert.equal(h.state().mode, "off");
  } finally { await h.close(); }
});

test("handoff context: rejected dispatch records no phantom ownership and explicit retry still deduplicates", async () => {
  const h = await harness();
  try {
    await h.prompt("/plan start"); await submit(h, sample);
    const send = h.session.sendUserMessage.bind(h.session);
    h.session.sendUserMessage = async () => { throw new Error("Injected rejection"); };
    h.confirm(true); await h.prompt("/plan implement");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!h.session.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "review-plan-handoff-v1"));
    assert.equal(h.state().mode, "ready");
    h.session.sendUserMessage = send;
    await h.session.reload();
    const request = await approve(h);
    assert.equal(copies(request.messages, sample), 1);
    assert.equal(h.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "review-plan-handoff-v1").length, 1);
  } finally { await h.close(); }
});

test("handoff context: changing the working draft after approval never changes the approved context", async () => {
  let draft = "";
  const h = await harness([pi => {
    pi.on("input", async event => {
      if (event.source === "extension" && event.text.startsWith("Plan mode has ended.")) await writeFile(draft, revised);
    });
  }]);
  try {
    await h.prompt("/plan start"); await submit(h, sample); draft = h.state().proposal!.path;
    const request = await approve(h);
    assert.equal(copies(request.messages, sample), 1);
    assert.equal(copies(request.messages, revised), 0);
    assert.equal(await readFile(draft, "utf8"), revised);
    assert.equal(await readFile(h.state().approved!.path, "utf8"), sample);
  } finally { await h.close(); }
});
