/** Exercise import admission against real native data and both physical resource limits. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getHistoryPath, locateItem, PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, syncLinearIssues, type LinearIssue } from "../index.ts";

const base = await mkdtemp(join(tmpdir(), "linear-import-admission-")), root = join(base, "tracker");
try {
  await mkdir(root);
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("admission");
  const issue: LinearIssue = { id: "admission-provider", identifier: "CAP-1", title: "Before", description: "Native body", priority: 2,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [] }, dueDate: null };
  const plan = buildItemPlan(issue, {});
  const native = await pm.create({ ...plan, tags: JSON.stringify(plan.tags), parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const id = native.item.id, located = await locateItem(root, id); assert.ok(located);
  const before = await readFile(located.itemPath), history = await readFile(getHistoryPath(root, id));
  issue.title = "Preview only";
  const options = { team: "CAP", limit: 1, dryRun: true, forwardOnly: true };
  const fetch = { fetchIssues: async () => [issue] };
  const admitted = await syncLinearIssues(options, root, fetch);
  assert.equal(admitted.updated, 1); assert.equal(admitted.skipped, 0);
  assert.deepEqual(await readFile(located.itemPath), before); assert.deepEqual(await readFile(getHistoryPath(root, id)), history);

  const oversized = join(root, "legacy-large.bin");
  await writeFile(oversized, ""); await truncate(oversized, 67108865);
  await assert.rejects(syncLinearIssues(options, root, fetch), /Tracker isolation budget exceeded/, "the unchanged 64 MiB byte quota refuses before source writes");
  assert.deepEqual(await readFile(located.itemPath), before); assert.deepEqual(await readFile(getHistoryPath(root, id)), history);
  await rm(oversized);

  const archive = join(root, "legacy-audit"); await mkdir(archive);
  // Regular hard-linked audit records count as distinct filesystem entries. ext4 caps one inode at 65,000 links, so
  // two seeds carry 32,768 links each (65,538 archive entries). Two operations at a time keep construction within host limits.
  for (const part of [0, 1]) {
    const seed = join(archive, `seed-${part}.json`); await writeFile(seed, "{}\n");
    for (let index = 0; index < 32768; index += 2) await Promise.all([index, index + 1].map((entry) => link(seed, join(archive, `record-${part}-${entry}.json`))));
  }
  await assert.rejects(syncLinearIssues(options, root, fetch), /Tracker isolation budget exceeded/, "the import-specific 65,536-entry quota remains enforced");
  assert.deepEqual(await readFile(located.itemPath), before); assert.deepEqual(await readFile(getHistoryPath(root, id)), history);
  const report = { sourceSha256: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../index.ts"))).digest("hex"),
    passed: 3, failed: 0, admittedSmallNativePreview: true, refusedEntryOverflow: true, refusedByteOverflow: true,
    maximumEntries: 65536, maximumBytes: 67108864, sourceItemAndHistoryUnchanged: true, gitRequired: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
