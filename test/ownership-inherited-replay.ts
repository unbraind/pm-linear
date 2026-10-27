/** Reproduce the inherited content-keyed import recovery gap without touching a git tracker. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { importLinearAtomic, type PreparedLinearImport } from "../index.ts";
const root = await mkdtemp(join(tmpdir(), "linear-replay-probe-"));
try {
  const pm = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("replay");
  const entry: PreparedLinearImport = { identifier: "SYN-1", linearId: "synthetic", title: "Imported first revision", status: "open", priority: 2, description: "[linear] linear_id=synthetic", body: "Synthetic body", tags: [] };
  const first = await importLinearAtomic(root, "SYN", [entry]);
  const id = first.itemIds.get(entry.identifier); assert.ok(id);
  await pm.update(id, { title: "Peer changed target revision", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const retry = await importLinearAtomic(root, "SYN", [entry]);
  const current = await pm.get(id);
  process.stdout.write(`${JSON.stringify({ sameTransaction: first.transactionId === retry.transactionId, replayReportedRecovered: retry.recovered, currentTargetStillDiffersFromInput: current.item.title !== entry.title })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
