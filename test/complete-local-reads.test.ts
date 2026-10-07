/** Real-tracker acceptance and degraded-envelope controls for local corpus reads. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  PmClient,
  commitImportedItem,
  getItemPath,
  readSettings,
  type PmCompleteListResult,
} from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { CommandError, certifyPmItems, syncLinearIssues, type LinearIssue } from "../index.ts";

/** Initialize an isolated real tracker, registering cleanup before any SDK work. */
async function tracker(t: TestContext): Promise<{ root: string; pm: PmClient }> {
  const root = await mkdtemp(join(tmpdir(), "linear-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("fixture");
  return { root, pm };
}

/** Construct synthetic provider data for the offline fetch seam, without credentials. */
function issue(identifier: string, stateType = "unstarted"): LinearIssue {
  return {
    id: `uuid-${identifier}`, identifier, title: `Imported ${identifier}`,
    description: `Complete body ${identifier}`, priority: 2,
    state: { name: stateType, type: stateType }, labels: { nodes: [] },
    dueDate: null, cycle: null, url: `https://linear.app/issue/${identifier}`,
  };
}

/** Require an actionable handled refusal instead of a partial/empty success. */
function isReadRefusal(err: unknown): boolean {
  assert.ok(err instanceof CommandError);
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /Complete local item read refused/);
  assert.match(err.message, /listAllComplete.*--strict-read.*--output-limit unbounded/);
  return true;
}

test("complete local corpus exports and matches beyond 10,000 real SDK items", async (t) => {
  const { root, pm } = await tracker(t);
  // Shared import adapter commits real TOON items and per-item history in-process.
  // Unlike 10,000 CLI launches or repeated similarity scans, this stays linear.
  const seed = await pm.create({
    id: "seed", title: "Seed", body: "Seed body", createMode: "progressive",
  });
  const settings = await readSettings(root);
  for (let index = 0; index < 10_001; index++) {
    const serial = String(index).padStart(5, "0");
    const id = `fixture-${serial}`;
    const result = await commitImportedItem({
      pmRoot: root, id, itemPath: getItemPath(root, "Task", id),
      document: {
        metadata: {
          ...seed.item, id, title: `Local ${serial}`,
          description: `[linear] linear_id=uuid-${serial}`,
        },
        body: `Unabridged local body ${serial}`,
      },
      author: "fixture", message: "Seed large complete-read fixture", settings,
      conflictWarningPrefix: "fixture_conflict",
    });
    assert.equal(result.committed, true);
  }
  const corpus = await pm.listAllComplete({ includeBody: true });
  assert.equal(corpus.complete_list.item_count, 10_002);
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"],
  });
  const { result } = await harness.runExporter({ exporter: "linear", pmRoot: root, options: {}, global: { json: true } });
  const exported = result as { exported: number; payloads: Array<{ title: string; description: string }> };
  assert.equal(exported.exported, 10_002);
  assert.ok(exported.payloads.some((item) => item.description.includes("Unabridged local body 10000")));
  const sync = await syncLinearIssues(
    { team: "FIXTURE", limit: 1, atomic: true, dryRun: true }, root,
    { fetchIssues: async () => [issue("10000")] },
  );
  assert.equal(sync.created, 0);
  assert.equal(sync.updated, 1);
  assert.equal((await pm.listAllComplete()).count, 10_002);
});

for (const atomic of [false, true]) {
  test(`terminal matching and second import create nothing (atomic=${atomic})`, async (t) => {
    const { root, pm } = await tracker(t);
    const issues = [issue("closed"), issue("canceled"), issue("new")];
    for (const status of ["closed", "canceled"]) {
      await pm.create({
        id: status, title: `Existing ${status}`, status, closeReason: "Fixture terminal work",
        description: `[linear] linear_id=uuid-${status}`, body: `Existing ${status} body`,
        createMode: "progressive", allowDuplicate: true,
      });
    }
    const options = { team: "FIXTURE", limit: 3, atomic };
    const first = await syncLinearIssues(options, root, { fetchIssues: async () => issues });
    assert.equal(first.created, 1);
    assert.equal(first.updated, 2);
    const second = await syncLinearIssues(options, root, { fetchIssues: async () => issues });
    assert.equal(second.created, 0);
    assert.ok(second.updated === 3 || second.recoveredItems === 3);
    const corpus = await pm.listAllComplete({ includeBody: true });
    assert.equal(corpus.count, 3);
    assert.equal(corpus.items.find((item) => item.id === "fixture-closed")?.status, "open");
    assert.equal(corpus.items.find((item) => item.id === "fixture-canceled")?.status, "open");
  });
}

/** Envelope mutations simulate lost transport evidence, never a mocked SDK read. */
type Degradation = { name: string; change: (envelope: Record<string, unknown>) => unknown };
const degradations: Degradation[] = [
  { name: "missing envelope", change: () => undefined },
  { name: "null envelope", change: () => null },
  { name: "array envelope", change: (e) => e.items },
  { name: "missing items", change: (e) => { delete e.items; return e; } },
  { name: "results alias", change: (e) => { e.results = e.items; delete e.items; return e; } },
  { name: "non-array items", change: (e) => ({ ...e, items: {} }) },
  ...["truncated", "has_more"].map((key) => ({ name: key, change: (e: Record<string, unknown>) => ({ ...e, [key]: true }) })),
  { name: "next_cursor", change: (e) => ({ ...e, next_cursor: "more" }) },
  { name: "row limit", change: (e) => ({ ...e, applied_limit: 10_000 }) },
  ...["count", "total"].map((key) => ({ name: `${key} mismatch`, change: (e: Record<string, unknown>) => ({ ...e, [key]: 2 }) })),
  { name: "partial source", change: (e) => ({ ...e, completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }) },
  { name: "unchecked source", change: (e) => ({ ...e, completeness: { status: "unchecked" } }) },
  { name: "missing certificate", change: (e) => { delete e.complete_list; return e; } },
  { name: "malformed certificate", change: (e) => ({ ...e, complete_list: [] }) },
  { name: "contradictory certificate", change: (e) => ({ ...e, complete_list: { ...(e.complete_list as object), item_count: 2 } }) },
  { name: "terminal exclusion", change: (e) => ({ ...e, filters: { ...(e.filters as object), exclude_terminal: true } }) },
  { name: "filtered corpus", change: (e) => ({ ...e, filters: { ...(e.filters as object), status: "open" } }) },
  { name: "non-strict source", change: (e) => ({ ...e, filters: { ...(e.filters as object), strict_read: false } }) },
  { name: "missing body echo", change: (e) => ({ ...e, filters: { ...(e.filters as object), include_body: false } }) },
  { name: "brief projection", change: (e) => ({ ...e, projection: { mode: "brief", fields: ["id"] } }) },
  { name: "field omissions", change: (e) => ({ ...e, omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: [{ name: "body" }] } }) },
  { name: "missing omission receipt", change: (e) => { delete e.omission_receipt; return e; } },
  { name: "missing read receipt", change: (e) => { delete e.read_output; return e; } },
  { name: "budget truncation", change: (e) => ({ ...e, output_budget_truncation: {} }) },
  { name: "budget omitted result", change: (e) => ({ ...e, output_budget_exceeded: { omitted_result: true } }) },
  { name: "session projection", change: (e) => ({ ...e, read_session: {} }) },
  ...["strings_compacted", "rows_compacted", "result_omitted"].map((key) => ({
    name: key, change: (e: Record<string, unknown>) => ({ ...e, read_output: { ...(e.read_output as object), [key]: true } }),
  })),
  { name: "missing read dimensions", change: (e) => ({ ...e, read_output: { ...(e.read_output as object), requested_dimensions: [] } }) },
  { name: "duplicate ids", change: (e) => ({ ...e, items: [...(e.items as unknown[]), ...(e.items as unknown[])], count: 2, total: 2 }) },
  ...[
    { name: "null row", row: null }, { name: "scalar row", row: "bad" },
    { name: "empty id", row: { id: "" } }, { name: "missing title", row: { title: undefined } },
    { name: "blank title", row: { title: " " } }, { name: "malformed status", row: { status: [] } },
    { name: "missing body", row: { body: undefined } }, { name: "malformed body", row: { body: {} } },
    { name: "malformed description", row: { description: [] } }, { name: "malformed deadline", row: { deadline: 42 } },
    { name: "malformed priority", row: { priority: "2" } }, { name: "negative priority", row: { priority: -1 } },
    { name: "excessive priority", row: { priority: 5 } }, { name: "malformed tags", row: { tags: "bug" } },
    { name: "malformed tag member", row: { tags: [42] } },
  ].map(({ name, row }) => ({
    name, change: (e: Record<string, unknown>) => ({
      ...e, items: [typeof row === "object" && row !== null ? { ...(e.items as object[])[0], ...row } : row],
    }),
  })),
];

test("every degraded real complete-read envelope refuses before reconciliation writes", async (t) => {
  const { root, pm } = await tracker(t);
  const seeded = await pm.create({ title: "Unchanged", body: "Full body", createMode: "progressive" });
  const corpus: PmCompleteListResult = await pm.listAllComplete({ includeBody: true });
  const before = await readFile(getItemPath(root, "Task", seeded.item.id), "utf8");
  let providerReads = 0;
  let commits = 0;
  for (const degradation of degradations) {
    await t.test(degradation.name, async () => {
      const envelope = structuredClone(corpus) as unknown as Record<string, unknown>;
      await assert.rejects(() => syncLinearIssues(
        { team: "FIXTURE", limit: 1, atomic: true }, root,
        {
          readItems: () => certifyPmItems(degradation.change(envelope)),
          fetchIssues: async () => { providerReads++; return [issue("new")]; },
          commitAtomic: async () => { commits++; throw new Error("must never commit"); },
        },
      ), isReadRefusal);
      assert.equal(providerReads, 0);
      assert.equal(commits, 0);
    });
  }
  assert.equal(await readFile(getItemPath(root, "Task", seeded.item.id), "utf8"), before);
  assert.equal((await pm.listAllComplete()).count, 1);
});

test("malformed tracker refuses import and push/preview before provider access or writes", async (t) => {
  const { root, pm } = await tracker(t);
  const seeded = await pm.create({ title: "Valid before damage", createMode: "progressive" });
  const itemPath = getItemPath(root, "Task", seeded.item.id);
  const invalid = "this is not a valid TOON item [";
  await writeFile(itemPath, invalid);
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"],
  });
  for (const options of [{}, { push: true, team: "FIXTURE" }, { "dry-run": true }]) {
    await assert.rejects(() => harness.runExporter({ exporter: "linear", pmRoot: root, options }), isReadRefusal);
  }
  await assert.rejects(() => harness.runImporter({
    importer: "linear", pmRoot: root, options: { team: "FIXTURE", "dry-run": true },
  }), isReadRefusal);
  let providerReads = 0;
  await assert.rejects(() => syncLinearIssues(
    { team: "FIXTURE", limit: 1 }, root,
    { fetchIssues: async () => { providerReads++; return [issue("new")]; } },
  ), isReadRefusal);
  assert.equal(providerReads, 0);
  assert.equal(await readFile(itemPath, "utf8"), invalid);
});

test("missing resolvable SDK produces a recovery hint on a standalone installed module", async (t) => {
  const { root } = await tracker(t);
  // Copy just the emitted module, as an older standalone extension host would.
  const target = join(root, "standalone.mjs");
  await writeFile(target, await readFile(new URL("../dist/index.js", import.meta.url)));
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { certifyPmItems } = await import(process.argv[1]);
    try { await certifyPmItems({}); process.exitCode = 2; }
    catch (error) { console.log(error.name + ': ' + error.message); }
  `, target], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /CommandError: Complete local item read refused/);
  assert.match(run.stdout, /Upgrade @unbrained\/pm-cli to >=2026.10.4/);
});
