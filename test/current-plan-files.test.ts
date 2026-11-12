import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanFiles, digest } from "../src/files.ts";

test("draft update preserves identity and approved bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-update-"));
  try {
    const files = new PlanFiles(root);
    const draft = await files.create("# First\n"), approved = await files.create("# First\n", "approved");
    const updated = await files.update(draft, "# Revised\n", () => true);
    assert.equal(updated.path, draft.path); assert.equal(updated.id, draft.id);
    assert.equal(updated.hash, digest("# Revised\n"));
    assert.equal(await readFile(draft.path, "utf8"), "# Revised\n");
    assert.equal(await files.read(approved, true), "# First\n");
    await assert.rejects(files.update(approved, "# Forbidden\n", () => true));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelled draft replacement preserves the existing file and removes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-update-"));
  try {
    const files = new PlanFiles(root), draft = await files.create("# Keep\n");
    let checks = 0;
    await assert.rejects(files.update(draft, "# Discard\n", () => ++checks === 1), /Planning changed/);
    assert.equal(await readFile(draft.path, "utf8"), "# Keep\n");
    assert.deepEqual(await readdir(root), [draft.path.split("/").at(-1)]);
    await assert.rejects(files.update(draft, "", () => true));
    assert.equal(await readFile(draft.path, "utf8"), "# Keep\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing current draft can be repaired without accepting another target", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-update-"));
  try {
    const files = new PlanFiles(root), draft = await files.create("# Original\n");
    await unlink(draft.path);
    assert.equal(await files.canEdit(draft, draft.path, root), true);
    assert.equal(await files.canEdit(draft, join(root, "plan-other.draft.md"), root), false);
    await files.update(draft, "# Restored\n", () => true);
    assert.equal(await readFile(draft.path, "utf8"), "# Restored\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
