/** Import mirrors admit legitimate native audit corpora while observation budgets and source safety remain enforced. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHistoryPath, locateItem, PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, previewLinearOwnership, syncLinearIssues, type LinearIssue } from "../index.ts";

test("import mirror policy preserves preview/apply parity above the observational entry limit", { timeout: 1200000 }, async (t) => {
  const savedKey = process.env.LINEAR_API_KEY; delete process.env.LINEAR_API_KEY;
  t.after(() => { if (savedKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = savedKey; });
  const base = await mkdtemp(join(tmpdir(), "linear-import-isolation-")), root = join(base, "tracker");
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  await mkdir(root);
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("isolation");
  const issue: LinearIssue = { id: "archive-provider", identifier: "ARCHIVE-1", title: "Before", description: "Before", priority: 2,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [] }, dueDate: null };
  const plan = buildItemPlan(issue, {});
  const native = await pm.create({ ...plan, tags: JSON.stringify(plan.tags), parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const id = native.item.id, located = await locateItem(root, id); assert.ok(located);
  const archive = join(root, "audit-archive"); await mkdir(archive);
  // These regular persisted audit files are independent of the one active item.
  // Native 10,002-item trackers likewise exceed 20,000 item/history entries.
  for (let index = 0; index < 20001; index += 2) await Promise.all([index, index + 1].map((entry) => writeFile(join(archive, `event-${entry}.json`), '{"legacyAudit":true}\n')));
  const before = await readFile(located.itemPath), history = await readFile(getHistoryPath(root, id));
  await assert.rejects(previewLinearOwnership({ item: id }, root), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error); assert.equal(error.code, "local_read_failed", "read-only observation keeps its 20,000-entry boundary"); return true;
  });
  for (const terminal of [false, true]) {
    issue.title = terminal ? "Complete" : "Updated"; issue.state = terminal ? { name: "Done", type: "completed" } : { name: "Queue", type: "unstarted" };
    const beforePreviewBytes: Buffer = await readFile(located.itemPath);
    const currentHistory: Buffer = await readFile(getHistoryPath(root, id));
    const options = { team: "ARCHIVE", limit: 1, forwardOnly: true };
    const preview = await syncLinearIssues({ ...options, dryRun: true }, root, { fetchIssues: async () => [issue] });
    assert.equal(preview.updated, 1); assert.equal(preview.skipped, 0); assert.equal(preview.dryRun, true);
    assert.deepEqual(await readFile(located.itemPath), beforePreviewBytes); assert.deepEqual(await readFile(getHistoryPath(root, id)), currentHistory);
    const applied = await syncLinearIssues(options, root, { fetchIssues: async () => [issue] });
    assert.deepEqual([preview.created, preview.updated, preview.skipped], [applied.created, applied.updated, applied.skipped]);
    assert.equal(applied.exit_code ?? 0, 0); assert.equal((await pm.get(id)).item.status, terminal ? "closed" : "open");
  }
  assert.notDeepEqual(await readFile(located.itemPath), before); assert.notDeepEqual(await readFile(getHistoryPath(root, id)), history);
  const outside = join(base, "outside.json"); await writeFile(outside, '{"untouched":true}\n');
  await symlink(outside, join(root, "unsupported-link"));
  await assert.rejects(syncLinearIssues({ team: "ARCHIVE", limit: 1, dryRun: true }, root, { fetchIssues: async () => [issue] }), /Unsupported tracker entry/);
  assert.equal(await readFile(outside, "utf8"), '{"untouched":true}\n', "larger import admission never follows source symlinks");
});
