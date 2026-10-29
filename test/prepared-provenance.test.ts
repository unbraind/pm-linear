/** Prepared SDK rows must use one provider identity for selection and persisted provenance. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getHistoryPath, PmClient } from "@unbrained/pm-cli/sdk";
import { buildItemPlan, importLinearAtomic, importLinearForwardOnly, parseProvenance, syncLinearIssues, type LinearIssue } from "../index.ts";

test("identity class: prepared declarations and written provenance agree before any target selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linear-prepared-identity-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" }); await pm.init("prepared");
  for (const title of ["Shared A", "Shared B"]) await pm.create({ title, description: "[linear] linear_id=shared", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const legacy = await pm.create({ title: "Legacy unlinked item", description: "Previously stored free text", parent: "none", unset: ["goal", "objective", "sprint", "release"] });
  const before = (await pm.listAllComplete({ includeBody: true })).items;
  const history = new Map(await Promise.all(before.map(async (row) => [row.id!, await readFile(getHistoryPath(root, row.id!))] as const)));
  const issue: LinearIssue = { id: "declared-fresh", identifier: "PREP-1", title: "Prepared target", description: "Body", priority: 2,
    state: { name: "Queue", type: "unstarted" }, labels: { nodes: [] }, dueDate: null };
  const plan = buildItemPlan(issue, {});
  for (const compatibility of [false, true]) for (const description of ["[linear] linear_id=shared", "Previously stored free text", ""]) {
    const entry = { ...plan, identifier: issue.identifier, linearId: issue.id, description };
    const result = compatibility ? await importLinearAtomic(root, "PREP", [entry], { forwardOnly: true }) : await importLinearForwardOnly(root, "PREP", [entry]);
    assert.equal((await pm.listAllComplete()).count, before.length, "inconsistent provenance must not create a third linked target or an unlinked duplicate");
    assert.equal(result.created, 0); assert.equal(result.updated, 0); assert.equal(result.skipped, 1);
    assert.equal(result.exit_code, 1); assert.equal(result.success, false); assert.equal(result.importResults?.[0].code, "import_conflict");
    assert.equal(result.importResults?.[0].id, null); assert.equal(result.itemIds.size, 0);
    assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
    for (const [id, bytes] of history) assert.deepEqual(await readFile(getHistoryPath(root, id)), bytes);
  }
  const malformed = { ...issue, id: "shared extra" };
  const refused = await syncLinearIssues({ team: "PREP", limit: 1 }, root, { fetchIssues: async () => [malformed] });
  assert.equal(refused.created, 0); assert.equal(refused.skipped, 1); assert.equal(refused.exit_code, 1);
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items, before);
  // Consistent opaque SDK identities and previously persisted free text remain usable.
  issue.id = "opaque:legacy-id";
  const allowed = await importLinearForwardOnly(root, "PREP", [{ ...buildItemPlan(issue, {}), linearId: issue.id, identifier: issue.identifier }]);
  assert.equal(allowed.created, 1); assert.equal(allowed.skipped, 0); assert.equal(allowed.exit_code ?? 0, 0);
  assert.equal(parseProvenance((await pm.get(allowed.itemIds.get(issue.identifier)!)).item.description)?.linear_id, issue.id);
  assert.deepEqual((await pm.listAllComplete({ includeBody: true })).items.find((row) => row.id === legacy.item.id), before.find((row) => row.id === legacy.item.id));
});
