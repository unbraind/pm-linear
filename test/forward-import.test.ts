/** Forward-only imports use SDK-normalized reference states and real non-git interleavings. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, PmClient, readSettings, readHistoryEntries, getHistoryPath, normalizeItemId, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, deriveAtomicItemId, syncLinearIssues, type LinearIssue, type LinearImportOutcome } from "../index.ts";

import { referenceLifecycle } from "./native-reference.ts";

/** A provider issue with a changing full set of portable fields. */
function provider(index: number): LinearIssue {
  return { id: `forward-${index}`, identifier: `ENG-${index}`, title: `Before ${index}`, description: "Body\r\nline", priority: 2, dueDate: null,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [{ name: "native" }] } };
}

/** Submit the model's portable values through the SDK; unchanged lifecycle state is omitted. */
async function applyReference(pm: PmClient, id: string, issue: LinearIssue, root: string) {
  const current = (await pm.get(id, { depth: "deep" })).item;
  const plan = buildItemPlan(issue, {});
  const { status, tags, deadline, assignee, ...fields } = plan;
  const lifecycle = await referenceLifecycle(root, current, status, assignee, `Linear issue ${issue.identifier} terminal`);
  await pm.update(id, { ...fields, tags: JSON.stringify(tags), ...lifecycle,
    ...(deadline ? { deadline } : {}), unset: [...(!deadline ? ["deadline"] : []), ...lifecycle.unset] });
}

test("forward-only title plus close survives a later failure and completed title edits never repeat close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-forward-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "fixture" }); await pm.init("forward");
  const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = root; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  const issues = [provider(0), provider(1)];
  const codeLinks = join(root, "extensions", "pm-linear", "node_modules", "@unbrained");
  await mkdir(codeLinks, { recursive: true });
  await symlink(join(root, "runtime-code-not-tracker-data"), join(codeLinks, "pm-cli"), "dir");
  await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues });
  const settings = await readSettings(root); const ids = issues.map((issue) => deriveAtomicItemId("ENG", issue.identifier, settings.id_prefix, normalizeItemId));
  issues[0].assignee = { name: "Remote Agent", email: null };
  issues[0].title = "Completed title"; issues[0].state = { name: "Complete", type: "completed" }; issues[1].title = "Later title";
  const result = await syncLinearIssues({ team: "ENG", limit: 10, atomic: true }, root, { fetchIssues: async () => issues,
    onEstimateBoundary: async (stage, id) => { if (stage === "before_update" && id === ids[1]) throw new Error("Later item fails"); } });
  assert.equal(result.updated, 1); assert.equal(result.skipped, 1); assert.equal(result.atomic, false);
  assert.deepEqual(result.importResults?.map((row) => [row.action, row.code]), [["updated", undefined], ["skipped", "import_failed"]]);
  assert.equal((await pm.get(ids[0])).item.status, "closed"); assert.equal((await pm.get(ids[0])).item.title, "[ENG-0] Completed title");
  assert.equal((await pm.get(ids[0])).item.assignee, undefined, "retain the native terminal assignee-release effect");
  assert.equal((await pm.get(ids[1])).item.title, "[ENG-1] Before 1");
  const before = await readHistoryEntries(getHistoryPath(root, ids[0]), ids[0]);
  assert.ok(before.some((row) => row.op === "close")); assert.ok(before.every((row) => row.op !== "restore"));
  issues[0].title = "Edit while completed";
  const edited = await syncLinearIssues({ team: "ENG", limit: 10, atomic: true }, root, { fetchIssues: async () => issues });
  assert.equal(edited.updated, 2); assert.equal(edited.skipped, 0);
  const after = await readHistoryEntries(getHistoryPath(root, ids[0]), ids[0]);
  assert.equal(after.length, before.length + 1); assert.equal(after.at(-1)?.op, "update");
  assert.equal((await pm.get(ids[0])).item.status, "closed"); assert.equal((await pm.get(ids[0])).item.title, "[ENG-0] Edit while completed");
  const replay = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues }); assert.equal(replay.synced, 0);
});

test("forward-only seeded 500 multi-item failure and peer schedules converge with exact SDK state and receipts", { timeout: 5400000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "linear-forward-model-")); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "actual"), referenceRoot = join(base, "reference");
  await mkdir(root); await mkdir(referenceRoot);
  const pm = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: "fixture" });
  const model = new PmClient({ pmRoot: referenceRoot, cwd: referenceRoot, noExtensions: true, author: process.env.PM_AUTHOR ?? "pm-linear" });
  for (const client of [pm, model]) await client.init("forward");
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => { if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling; });
  const issues = [provider(0), provider(1), provider(2)]; const oldInputs: LinearIssue[][] = [];
  await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues });
  const settings = await readSettings(root); const ids = issues.map((issue) => deriveAtomicItemId("ENG", issue.identifier, settings.id_prefix, normalizeItemId));
  for (const [index, id] of ids.entries()) {
    const plan = buildItemPlan(issues[index], {});
    await model.create({ ...plan, id, tags: JSON.stringify(plan.tags), parent: "none", unset: ["goal", "objective", "sprint", "release"] });
    for (const client of [pm, model]) await client.update(id, { estimatedMinutes: String(100 + index) });
  }
  const stages = ["observed", "inspect", "before_write", "validated", "before_update", "written", "after_write"];
  let seed = 15761620;
  const rng = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const fields = ["id", "type", "author", "title", "body", "status", "priority", "description", "tags", "deadline", "assignee", "parent", "goal", "objective", "sprint", "release", "dependencies", "estimated_minutes", "close_reason"] as const;
  for (let sequence = 0; sequence < 500; sequence++) {
    const desired = oldInputs.length && sequence % 9 === 0 ? structuredClone(oldInputs[rng() % oldInputs.length]) : issues.map((issue, index) => ({ ...issue,
      title: ` Work ${sequence}-${index} `, description: ` Body ${sequence}${sequence % 2 ? "\r\n" : "\n"}line `,
      priority: 1 + rng() % 4, dueDate: sequence % 2 ? null : "2026-12-01", assignee: sequence % 3 ? null : { name: " Agent ", email: null },
      state: index === sequence % 3 ? { name: "Complete", type: "completed" } : { name: "Queue", type: "unstarted" },
      labels: { nodes: [{ name: ` tag-${sequence % 5} ` }] } }));
    oldInputs.push(structuredClone(desired));
    const referenceVersions = await Promise.all(ids.map(async (id) => (await readHistoryEntries(getHistoryPath(referenceRoot, id), id)).length));
    for (let index = 0; index < ids.length; index++) await applyReference(model, ids[index], desired[index], referenceRoot);
    const before = await Promise.all(ids.map((id) => pm.get(id, { depth: "deep" }).then((row) => row.item)));
    const failureItem = sequence % 3, failureStage = stages[Math.floor(sequence / 3) % stages.length];
    const peerItem = (sequence + 1) % 3, peerStage = stages[Math.floor(sequence / 21) % stages.length];
    let failed = false, peerWritten = false;
    let peer: typeof before[number] | undefined;
    const result = await syncLinearIssues({ team: "ENG", limit: 10, atomic: Boolean(sequence % 2) }, root, { fetchIssues: async () => sequence % 2 ? [...desired].reverse() : desired,
      onEstimateBoundary: async (stage, id) => {
        if (!peerWritten && stage === peerStage && id === ids[peerItem]) {
          peerWritten = true; await pm.update(id, { title: `Peer ${sequence}`, estimatedMinutes: String(500 + sequence) });
          peer = (await pm.get(id, { depth: "deep" })).item;
        }
        if (!failed && stage === failureStage && id === ids[failureItem]) { failed = true; throw new Error("Seeded failure"); }
      } });
    assert.equal(result.importMode, "forward-only"); assert.equal(result.importResults?.length, 3);
    assert.equal(result.updated, result.importResults!.filter((row) => row.action === "updated").length);
    assert.equal(result.skipped, result.importResults!.filter((row) => row.action === "skipped").length);
    for (const [index, id] of ids.entries()) {
      const receipt: LinearImportOutcome = result.importResults!.find((row) => row.id === id)!;
      const actual = (await pm.get(id, { depth: "deep" })).item;
      const expected = index === peerItem && peer ? peer : receipt.action === "skipped" ? before[index] : (await model.get(id, { depth: "deep" })).item;
      for (const field of fields) assert.deepEqual(actual[field], expected[field], `sequence ${sequence}, ${index}, ${field}`);
      if (receipt.action === "skipped") assert.ok(["import_conflict", "import_failed"].includes(receipt.code!));
    }
    // Reconcile the independent reference state machine: a refused operation did
    // not apply to that item, and peer writes are separate SDK transitions.
    for (const [index, id] of ids.entries()) {
      if (result.importResults!.find((row) => row.id === id)!.action === "skipped") await model.restore(id, String(referenceVersions[index]));
      if (peerWritten && index === peerItem) await model.update(id, { title: `Peer ${sequence}`, estimatedMinutes: String(500 + sequence) });
    }
    // The independent model replays the same operation too: native close can clear
    // assignee on transition, while a later edit of that terminal item omits status.
    for (let index = 0; index < ids.length; index++) await applyReference(model, ids[index], desired[index], referenceRoot);
    // A fresh retry observes today's base and converges through the ordinary SDK.
    const retry = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => desired }); assert.equal(retry.skipped, 0);
    for (const [index, id] of ids.entries()) {
      if (peerWritten && index === peerItem) await model.update(id, { estimatedMinutes: String(500 + sequence) });
      const actual = (await pm.get(id, { depth: "deep" })).item, expected = (await model.get(id, { depth: "deep" })).item;
      for (const field of fields) assert.deepEqual(actual[field], expected[field], `retry ${sequence}, ${index}, ${field}`);
    }
    const stable = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => desired });
    assert.equal(stable.synced, 0, `fixed point ${sequence}`); assert.equal(stable.skipped, 0);
    if (sequence % 100 === 0) process.stdout.write(`forward sequences: ${sequence}/500\n`);
  }
});

test("forward-only skipped prerequisite skips all dependent writes using SDK graph semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-forward-deps-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("forward");
  const issues = [provider(0), provider(1), provider(2)];
  const initial = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues }); assert.equal(initial.created, 3);
  const settings = await readSettings(root), ids = issues.map((issue) => deriveAtomicItemId("ENG", issue.identifier, settings.id_prefix, normalizeItemId));
  await pm.update(ids[1], { dep: [`id=${ids[0]},kind=blocked_by`] });
  const before = (await pm.get(ids[1], { depth: "deep" })).item;
  issues.forEach((issue) => { issue.title = "New title"; });
  const result = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues,
    onEstimateBoundary: async (stage, id) => { if (stage === "before_update" && id === ids[0]) throw new Error("Prerequisite fails"); } });
  assert.equal(result.updated, 1); assert.equal(result.skipped, 2);
  assert.equal(result.importResults?.find((row) => row.id === ids[1])?.code, "import_conflict");
  assert.deepEqual((await pm.get(ids[1], { depth: "deep" })).item, before);
  const retry = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => issues }); assert.equal(retry.skipped, 0); assert.equal(retry.updated, 2);
});

test("forward-only primary terminal roles retain SDK-normalized assignee release on creation and every replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-forward-terminal-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("forward");
  const issue = provider(0); issue.state = { name: "Complete", type: "completed" }; issue.assignee = { name: "Remote Agent", email: null };
  const result = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] }); assert.equal(result.created, 1);
  const target = result.importResults![0].id!;
  const reference = await pm.create({ title: "Native lifecycle reference", status: "open", assignee: issue.assignee.name!, parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const normalized = await pm.close(reference.item.id, "Native reference close");
  assert.equal((await pm.get(target)).item.assignee, normalized.item.assignee);
  for (let replay = 0; replay < 3; replay++) {
    const before = await readHistoryEntries(getHistoryPath(root, target), target);
    const unchanged = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] });
    assert.equal(unchanged.synced, 0); assert.equal(unchanged.skipped, 0);
    assert.deepEqual(await readHistoryEntries(getHistoryPath(root, target), target), before);
  }
});


test("forward-only native lock conflicts leave peer leases and every field untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-forward-lock-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("forward");
  const issue = provider(0); const initial = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] });
  const id = initial.importResults![0].id!, before = (await pm.get(id, { depth: "deep" })).item;
  let release: Awaited<ReturnType<typeof acquireLock>> | undefined;
  issue.title = "Must not be saved";
  try {
    const result = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue],
      onEstimateBoundary: async (stage, target) => { if (stage === "before_update" && target === id) release = await acquireLock(root, id, 60, "peer"); } });
    assert.equal(result.updated, 0); assert.equal(result.skipped, 1); assert.equal(result.unconfirmed, 0);
    assert.equal(result.importResults?.[0].code, "import_conflict");
    assert.deepEqual((await pm.get(id, { depth: "deep" })).item, before);
    await assert.rejects(acquireLock(root, id, 60, "competitor"), /lock|locked/i, "import never releases a peer's lease");
  } finally { await release?.(); }
  const retry = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] }); assert.equal(retry.updated, 1); assert.equal(retry.skipped, 0);
});

test("forward-only creation does not inherit an assigned actor's ambient focus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-forward-focus-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ pmRoot: root, noExtensions: true, author: process.env.PM_AUTHOR ?? "pm-linear" }); await pm.init("forward");
  const focus = await pm.create({ title: "Assigned focus", type: "Epic", assignee: "Peer", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  await pm.focus(focus.item.id);
  const issue = provider(0); const result = await syncLinearIssues({ team: "ENG", limit: 10 }, root, { fetchIssues: async () => [issue] });
  assert.equal(result.created, 1); assert.equal(result.skipped, 0);
  const created = (await pm.get(result.importResults![0].id!, { depth: "deep" })).item;
  for (const field of ["parent", "goal", "objective", "sprint", "release", "assignee", "deadline"] as const) assert.equal(created[field], undefined, field);
});
