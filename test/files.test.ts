import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PlanFiles, normalizePlan, digest } from "../src/files.ts";
import { restoreState, STATE } from "../src/state.ts";
import { planPrompt, kickoff } from "../src/prompts.ts";

test("reject empty, oversized UTF-8 and terminal control input", () => {
  assert.throws(() => normalizePlan("  "));
  assert.throws(() => normalizePlan("中".repeat(18000)));
  assert.throws(() => normalizePlan("\x1b[31m"));
  assert.equal(normalizePlan(" # Plan "), "# Plan\n");
});
test("draft edits do not change approved bytes; tampering and symlinks fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-files-"));
  try {
    const files = new PlanFiles(root);
    const draft = await files.create("# Plan\n");
    const approved = await files.create(await files.read(draft), "approved");
    await writeFile(draft.path, "# Changed\n");
    assert.equal(await files.read(approved, true), "# Plan\n");
    assert.equal(await files.read(draft), "# Changed\n");
    await writeFile(approved.path, "tampered");
    await assert.rejects(files.read(approved, true), /changed/);
    const alias = { ...draft, path: join(root, "plan-alias.draft.md") };
    await symlink(draft.path, alias.path);
    await assert.rejects(files.read(alias));
    await assert.rejects(files.read({ ...draft, path: join(root, "..", "elsewhere.md") }), /outside/);
    assert.equal(await readFile(draft.path, "utf8"), "# Changed\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("state is branch-local and rejects unsupported versions", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: STATE, data });
  assert.equal(restoreState([]).mode, "off");
  assert.equal(restoreState([entry({ version: 1, mode: "planning" })]).mode, "planning");
  assert.equal(restoreState([entry({ version: 1, mode: "planning" }), entry({ version: 1, mode: "off" })]).mode, "off");
  assert.throws(() => restoreState([entry({ version: 2, mode: "off" })]));
  assert.throws(() => restoreState([entry({ version: 1, mode: "ready" })]));
});
test("acceptance-first prompt leaves question timing to the model and preserves authority", () => {
  const prompt = planPrompt(true);
  assert.ok(prompt.indexOf("2. Acceptance") < prompt.indexOf("3. Execution"));
  assert.match(prompt, /decide whether and when to ask/);
  assert.match(prompt, /cannot be verified as unverified/);
  assert.match(prompt, /key assumptions change/);
  assert.doesNotMatch(planPrompt(false), /use the existing ask_user_question/);
  const ref = { id: "test", path: "/plan.md", hash: digest("fixed"), title: "fixed" };
  assert.match(kickoff(ref, "fixed"), /Do not follow later draft edits/);
});
