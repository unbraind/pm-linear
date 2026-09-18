import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExtensionTestHarness,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

import extension, {
  applyPushDynamicFields,
  buildExportMutationPlan,
  buildItemPlan,
  buildProvenance,
  buildAtomicImportMutations,
  deriveAtomicTransactionId,
  importLinearAtomic,
  normalizeDueDate,
  parseFieldMap,
  parseProvenance,
  resetCycleWarning,
  resolveStatus,
  resolveTeamSelection,
  syncLinearIssues,
  type LinearIssue,
  type PreparedLinearImport,
} from "../index.ts";

/** A typed Linear issue fixture with every optional field absent by default. */
function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "uuid-eng-1",
    identifier: "ENG-1",
    title: "Title",
    description: "Description",
    priority: 2,
    estimate: null,
    state: { name: "In Progress", type: "started" },
    labels: { nodes: [] },
    assignee: null,
    dueDate: null,
    cycle: null,
    project: null,
    customer: null,
    url: "https://linear.app/issue/ENG-1",
    ...overrides,
  };
}

/** A typed atomic-import fixture used by deterministic identity tests. */
function prepared(identifier: string, overrides: Partial<PreparedLinearImport> = {}): PreparedLinearImport {
  return {
    identifier,
    linearId: `uuid-${identifier.toLowerCase()}`,
    title: `Title ${identifier}`,
    status: "open",
    priority: 2,
    description: buildProvenance({
      id: `uuid-${identifier.toLowerCase()}`,
      identifier,
    }),
    body: `Body ${identifier}`,
    tags: ["bug"],
    ...overrides,
  };
}

/** Create a real empty pm workspace for atomic SDK paths that read settings. */
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-branch-"));
  return root;
}

let harness: ExtensionTestHarness | undefined;
async function getHarness(): Promise<ExtensionTestHarness> {
  if (!harness) {
    harness = await createExtensionTestHarness(extension, {
      name: "pm-linear",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
    assert.deepEqual(harness.activation.failed, []);
  }
  return harness;
}

test("option readers cover non-string teams, numeric limits, and project-map spellings", async () => {
  assert.deepEqual(resolveTeamSelection({ team: 123 }), { team: "123", source: "flag" });

  const root = workspace();
  try {
    const h = await getHarness();
    const numeric = await h.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, limit: 7 },
      pmRoot: root,
      global: { json: true },
    });
    assert.equal((numeric.result as { request: { variables: { first: number } } }).request.variables.first, 7);

    const invalid = await h.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, limit: "not-a-number" },
      pmRoot: root,
      global: { json: true },
    });
    assert.equal((invalid.result as { request: { variables: { first: number } } }).request.variables.first, 100);

    const nullLimit = await h.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, limit: null },
      pmRoot: root,
      global: { json: true },
    });
    assert.equal((nullLimit.result as { request: { variables: { first: number } } }).request.variables.first, 100);

    const falseMap = await h.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": false },
      pmRoot: root,
      global: { json: true },
    });
    assert.equal((falseMap.result as { projectMap: { enabled: boolean } }).projectMap.enabled, false);

    const numericMap = await h.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": 42 },
      pmRoot: root,
      global: { json: true },
    });
    assert.equal((numericMap.result as { projectMap: { enabled: boolean } }).projectMap.enabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("import mapping covers priority cases, state-name fallbacks, and ignored fields", () => {
  for (const [priority, expected] of [[3, 3], [4, 4], [0, 3]] as const) {
    assert.equal(buildItemPlan(issue({ priority }), {}).priority, expected);
  }
  assert.equal(resolveStatus("unstarted", "In Review", {}), "in_progress");
  assert.equal(resolveStatus("unstarted", "Blocked by dependency", {}), "blocked");
  assert.equal(resolveStatus("unstarted", "Done", {}), "closed");
  assert.equal(resolveStatus("unstarted", "Cancelled", {}), "closed");
  assert.equal(resolveStatus("cancelled", "Anything", {}), "closed");
  assert.equal(resolveStatus("completed", "Anything", {}), "closed");

  assert.equal(buildItemPlan(issue({ description: null }), {}).body, "");
  const plan = buildItemPlan(
    issue({ description: null }),
    {},
    parseFieldMap("title=ignore,description=ignore,status=ignore"),
  );
  assert.equal(plan.title, "[ENG-1] (untitled)");
  assert.equal(plan.body, "");
  assert.equal(plan.status, "open");
});

test("field/provenance/date parsing covers malformed and missing optional data", () => {
  assert.deepEqual(parseFieldMap("junk,labels=tags"), { labels: "tags" });
  assert.equal(parseProvenance("[linear] linear_url=https://linear.app/x"), undefined);
  assert.deepEqual(parseProvenance("[linear] linear_id=lin-1"), {
    linear_id: "lin-1",
    linear_url: "",
  });
  assert.equal(normalizeDueDate("   "), undefined);
  assert.equal(normalizeDueDate("not a date"), undefined);
});

test("atomic identity and mutation sorting cover comparator and optional fields", () => {
  const first = prepared("ENG-1", { deadline: "2026-01-01", assignee: "ada@example.com" });
  const second = prepared("ENG-2");
  const normalize = (input: string, prefix: string): string => `${prefix}${input.toLowerCase()}`;
  const plan = buildAtomicImportMutations("ENG", first, "pm-", normalize);
  assert.equal(plan.mutations.length, 2);
  assert.equal(plan.mutations[0].op, "create");
  assert.equal(plan.mutations[1].op, "update");
  const mutations = [
    ...plan.mutations,
    ...buildAtomicImportMutations("ENG", second, "pm-", normalize).mutations,
  ];
  const transaction = deriveAtomicTransactionId("ENG", [second, first], mutations);
  const reorderedTransaction = deriveAtomicTransactionId("ENG", [first, second], mutations);
  const equalIdentifier = deriveAtomicTransactionId("ENG", [first, { ...first, title: "same key" }], mutations);
  assert.equal(reorderedTransaction, transaction);
  assert.match(equalIdentifier, /^linear-import-[0-9a-f]{16}$/);
  assert.match(transaction, /^linear-import-[0-9a-f]{16}$/);
});

test("atomic import sorts equal identifiers through the real mutation seam", async () => {
  const root = workspace();
  try {
    const one = prepared("ENG-1");
    const two = prepared("ENG-1", { title: "Second representation" });
    const result = await importLinearAtomic(root, "ENG", [two, one], {
      readSettings: async () => ({ id_prefix: "pm-" }),
      normalizeItemId: (input: string, prefix: string) => `${prefix}${input.toLowerCase()}`,
      commitItemMutations: async () => ({
        transactionId: "tx",
        status: "committed" as const,
        recovered: false,
        results: {},
      }),
    });
    assert.equal(result.imported, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic import reports a non-Error settings-read rejection", async () => {
  const root = workspace();
  try {
    await assert.rejects(
      () =>
        importLinearAtomic(root, "ENG", [prepared("ENG-1"), prepared("ENG-2")], {
          readSettings: async () => Promise.reject("settings failure"),
          normalizeItemId: (input: string, prefix: string) => `${prefix}${input.toLowerCase()}`,
          commitItemMutations: async () => ({
            transactionId: "unused",
            status: "committed" as const,
            recovered: false,
            results: {},
          }),
        }),
      /could not read workspace settings.*settings failure/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic import wraps a non-Error SDK rejection as a generic CommandError", async () => {
  const root = workspace();
  try {
    await assert.rejects(
      () =>
        importLinearAtomic(root, "ENG", [prepared("ENG-1")], {
          commitItemMutations: async () => Promise.reject("string failure"),
          normalizeItemId: (input: string, prefix: string) => `${prefix}${input.toLowerCase()}`,
          readSettings: async () => ({ id_prefix: "pm-" }),
        }),
      (err: unknown) => {
        assert.match(String(err), /Atomic Linear import failed/);
        assert.match(String(err), /string failure/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync scope logging covers every optional filter and the atomic fetch seam", async () => {
  const result = await syncLinearIssues(
    {
      team: "ENG",
      limit: 10,
      project: "Project",
      assignee: "ada@example.com",
      label: "bug",
      updatedSince: "-P7D",
      stateFilter: "Progress",
      cycleFilter: "Sprint",
      atomic: true,
      dryRun: true,
    },
    "/unused",
    {
      fetchIssues: async () => [],
      readItems: () => [],
    },
  );
  assert.equal(result.atomic, undefined, "empty fetch returns before atomic preparation");
  assert.equal(result.synced, 0);

  const withOptionalFields = await syncLinearIssues(
    { team: "ENG", limit: 10, atomic: true, dryRun: true },
    "/unused",
    {
      fetchIssues: async () => [
        issue({
          dueDate: "2026-01-02",
          assignee: { email: "ada@example.com", name: "Ada" },
        }),
      ],
      readItems: () => [],
    },
  );
  assert.equal(withOptionalFields.created, 1);

  const recovered = await syncLinearIssues(
    { team: "ENG", limit: 10, atomic: true },
    "/unused",
    {
      fetchIssues: async () => [issue()],
      readItems: () => [],
      commitAtomic: async () => ({
        imported: 0,
        updated: 1,
        transactionId: "tx",
        recovered: true,
        itemIds: new Map<string, string>(),
      }),
    },
  );
  assert.equal(recovered.recovered, true);
});

test("export-plan target state null and default cycle warning sink are covered", () => {
  const plan = buildExportMutationPlan(
    { title: "No status", description: "", alreadyInLinear: false },
    {},
  );
  assert.equal(plan.targetStateName, null);

  resetCycleWarning();
  assert.doesNotThrow(() =>
    applyPushDynamicFields(
      {},
      { title: "x", description: "", cycleName: "Ghost", alreadyInLinear: false },
      {},
    ),
  );
});

test("export human branches render dry-run and payload previews from a real pm item", async () => {
  const root = workspace();
  const pm = process.platform === "win32" ? "pm.cmd" : "pm";
  const init = spawnSync(pm, ["--path", root, "init", "test"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync(
    pm,
    [
      "--path",
      root,
      "create",
      "--title",
      "Export branches",
      "--status",
      "in_progress",
      "--priority",
      "3",
      "--description",
      "[linear] linear_id=lin-1 linear_url=https://linear.app/ENG-1",
      "--body",
      "Body",
      "--tags",
      "bug,estimate:5,cycle:Sprint 1",
      "--deadline",
      "2026-01-02",
      "--assignee",
      "ada@example.com",
    ],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  assert.equal(add.status, 0, add.stderr);
  const fresh = spawnSync(
    pm,
    ["--path", root, "create", "--title", "Fresh export", "--status", "open", "--priority", "1", "--description", "fresh"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  assert.equal(fresh.status, 0, fresh.stderr);
  try {
    const h = await getHarness();
    const dry = await h.runExporter({
      exporter: "linear",
      options: { "dry-run": true },
      pmRoot: root,
      global: { json: false },
    });
    assert.equal((dry.result as { dryRun: boolean; wouldUpdate: number }).dryRun, true);
    assert.equal((dry.result as { wouldUpdate: number }).wouldUpdate, 1);

    const preview = await h.runExporter({
      exporter: "linear",
      options: {},
      pmRoot: root,
      global: { json: false },
    });
    assert.equal((preview.result as { pushed: boolean; wouldUpdate: number }).pushed, false);
    assert.equal((preview.result as { wouldUpdate: number }).wouldUpdate, 1);

    const withTeam = await h.runExporter({
      exporter: "linear",
      options: { team: "ENG" },
      pmRoot: root,
      global: { json: false },
    });
    assert.equal((withTeam.result as { team: string }).team, "ENG");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight override skips a sync dry-run that has no network dependency", async () => {
  const h = await getHarness();
  const result = await h.runPreflightOverride({
    command: "linear sync",
    args: [],
    options: { "dry-run": true },
    global: {},
    pm_root: "",
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  });
  assert.equal(result.overridden, true);
  const options = (result as { context?: { options?: Record<string, unknown> } }).context?.options ?? {};
  assert.equal(options["__linear_preflight_error"], undefined);
});

test("validate human output reports the offline readiness lines", async () => {
  const h = await getHarness();
  const root = workspace();
  try {
    const result = await h.runCommand({
      command: "linear validate",
      options: {},
      pmRoot: root,
      global: { json: false },
    });
    assert.equal((result.result as { apiKeyPresent: boolean }).apiKeyPresent, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
