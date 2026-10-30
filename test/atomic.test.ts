import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  buildAtomicImportMutations,
  deriveAtomicItemId,
  deriveAtomicTransactionId,
  importLinearForwardOnly,
  syncLinearIssues,
} from "../index.ts";
import type { PreparedLinearImport, LinearIssue } from "../index.ts";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = {
  encoding: "utf-8" as const,
  shell: process.platform === "win32",
};

// A normalizeItemId stand-in mirroring the SDK: prefix + lowercased input with
// non-alphanumerics folded to dashes. The real SDK helper is used in the
// integration tests below (freshTracker + the real `pm`); this pure stub keeps
// the pure-plan tests offline and deterministic.
function fakeNormalize(input: string, prefix: string): string {
  // Trim the dashes by index rather than by regex. `/^-+|-+$/g` is quadratic on
  // a long run of dashes because the `-+$` branch is retried from every
  // position, and splitting it into two anchored patterns does not fix it: a
  // bare `/-+$/` is still tried at each start position, so CodeQL flags it too
  // (js/polynomial-redos). Two index walks are unambiguously linear and need no
  // reasoning about backtracking at all.
  const folded = input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = folded.length;
  while (start < end && folded[start] === "-") start++;
  while (end > start && folded[end - 1] === "-") end--;
  const slug = folded.slice(start, end);
  return `${prefix}${slug}`;
}

function entry(
  identifier: string,
  title: string,
  overrides: Partial<PreparedLinearImport> = {},
): PreparedLinearImport {
  return {
    identifier,
    // Linear internal UUID; carried for provenance parity but never used as
    // the managed id.
    linearId: `uuid-${identifier.toLowerCase()}`,
    title,
    status: "open",
    priority: 3,
    description: `[linear] linear_id=uuid-${identifier.toLowerCase()} linear_url=https://linear.app/issue/${identifier}`,
    body: `Body ${identifier}`,
    tags: ["bug"],
    ...overrides,
  };
}

// A minimal LinearIssue for the fetchIssues test seam. Only the fields the
// import path reads are populated; the rest default to empty/null.
function makeIssue(
  identifier: string,
  title: string,
  overrides: Partial<{
    stateName: string;
    stateType: string;
    body: string;
  }> = {},
): LinearIssue {
  return {
    id: `uuid-${identifier.toLowerCase()}`,
    identifier,
    title,
    description: overrides.body ?? `Body ${identifier}`,
    priority: 2,
    estimate: null,
    state: { name: overrides.stateName ?? "In Progress", type: overrides.stateType ?? "started" },
    labels: { nodes: [{ name: "bug" }] },
    assignee: null,
    dueDate: null,
    cycle: null,
    project: null,
    customer: null,
    url: `https://linear.app/issue/${identifier}`,
  };
}

function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-atomic-"));
  try {
    const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
    assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
    assert.strictEqual(itemCount(root), 0, "fresh tracker must be empty");
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function listItems(
  root: string,
): Array<{ id: string; title: string; status: string }> {
  const result = spawnSync(
    PM_BIN,
    ["--path", root, "list-all", "--json", "--full", "--limit", "100"],
    PM_SPAWN_OPTS,
  );
  assert.strictEqual(
    result.status,
    0,
    `pm list-all failed: ${result.error?.message ?? result.stderr}`,
  );
  const parsed = JSON.parse(result.stdout) as {
    items?: Array<{ id: string; title: string; status: string }>;
  };
  return parsed.items ?? [];
}

function itemCount(root: string): number {
  return listItems(root).length;
}

function validateOk(root: string): boolean {
  return spawnSync(PM_BIN, ["--path", root, "validate"], PM_SPAWN_OPTS).status === 0;
}

// ---------------------------------------------------------------------------
// 1. mid-run failure → reverse compensation restores created/updated/closed
// ---------------------------------------------------------------------------
test("a failed forward batch retains applied creates and retries without duplicates", async () => {
  const root = freshTracker();
  try {
    const entries = [entry("ENG-20", "Keep one"), entry("ENG-21", "Retry two")];
    const result = await importLinearForwardOnly(root, "ENG", entries, { onBoundary: async (stage, id) => {
      if (stage === "before_update" && id.endsWith("-21")) throw new Error("Injected item failure");
    } });
    assert.equal(result.imported, 1); assert.equal(result.skipped, 1); assert.equal(result.atomic, false);
    assert.equal(itemCount(root), 1); assert.equal(listItems(root)[0].title, "Keep one");
    assert.equal(result.importResults?.find((row) => row.action === "skipped")?.code, "import_failed");
    const retry = await importLinearForwardOnly(root, "ENG", entries); assert.equal(retry.imported, 1); assert.equal(retry.updated, 0);
    assert.equal(itemCount(root), 2); assert.ok(validateOk(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a failed mixed batch retains completed updates and closes while skipping a failed item", async () => {
  const root = freshTracker();
  try {
    const initial = await importLinearForwardOnly(root, "ENG", [entry("ENG-30", "Original update target"), entry("ENG-31", "Original close target"), entry("ENG-32", "Last")]);
    const updateId = initial.itemIds.get("ENG-30")!, closeId = initial.itemIds.get("ENG-31")!;
    const result = await importLinearForwardOnly(root, "ENG", [entry("ENG-30", "Mutated title", { body: "Mutated body" }),
      entry("ENG-31", "Completed title", { status: "closed" }), entry("ENG-32", "Failed last")], {
      onBoundary: async (stage, id) => { if (stage === "before_update" && id.endsWith("-32")) throw new Error("Last item fails"); },
    });
    assert.equal(result.updated, 2); assert.equal(result.skipped, 1);
    const items = listItems(root);
    assert.equal(items.find((row) => row.id === updateId)?.title, "Mutated title");
    assert.equal(items.find((row) => row.id === updateId)?.status, "open");
    assert.equal(items.find((row) => row.id === closeId)?.title, "Completed title");
    assert.equal(items.find((row) => row.id === closeId)?.status, "closed");
    assert.equal(items.find((row) => row.id === initial.itemIds.get("ENG-32"))?.title, "Last");
    assert.equal(itemCount(root), 3); assert.ok(validateOk(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("forward import retries reordered input from live state without duplicates", async () => {
  const root = freshTracker();
  try {
    const entries = [entry("ENG-1", "First"), entry("ENG-2", "Second")];
    const first = await importLinearForwardOnly(root, "ENG", entries);
    assert.strictEqual(first.imported, 2);
    assert.strictEqual(first.updated, 0);
    assert.strictEqual(first.recovered, false);
    assert.strictEqual(itemCount(root), 2);

    // Re-run the same fetched set (reversed, as if the API page order changed)
    // with the prior committed items supplied as provenance matches. The
    // durable journal recognizes the same transaction id and resumes it,
    // reporting recovery rather than new work, with zero duplicates.
    const resumedEntries = [...entries].reverse().map((candidate) => ({
      ...candidate,
      match: {
        id: first.itemIds.get(candidate.identifier),
        status: "open",
      },
    }));
    const resumed = await importLinearForwardOnly(root, "ENG", resumedEntries);
    assert.notStrictEqual(resumed.transactionId, first.transactionId, "the compatibility receipt is bound to the observed target revisions");
    assert.strictEqual(resumed.recovered, false);
    assert.strictEqual(resumed.imported, 0, "a recovered journal is not misreported as new work");
    assert.strictEqual(resumed.updated, 0, "a recovered journal is not misreported as updates");
    assert.equal(resumed.importResults?.filter((row) => row.action === "unchanged").length, 2);
    assert.strictEqual(itemCount(root), 2, "resumed import does not duplicate items");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. reordered-retry stability → shuffled fetch order yields the SAME
//    transaction id & item ids
// ---------------------------------------------------------------------------
test("transaction identity is content-sensitive and independent of fetch order", () => {
  const first = entry("ENG-1", "First");
  const second = entry("ENG-2", "Second");
  const plan = [
    { op: "update" as const, id: "test-first", options: { title: "First" } },
    { op: "update" as const, id: "test-second", options: { title: "Second" } },
  ];
  const id = deriveAtomicTransactionId("ENG", [first, second], plan);
  assert.match(id, /^linear-import-[0-9a-f]{16}$/);
  // Same rendered issues in another order resume the same transaction.
  assert.strictEqual(
    deriveAtomicTransactionId("eng", [second, first], plan),
    id,
    "same rendered issues in another order resume the same transaction",
  );
  // Changed desired state starts a fresh transaction.
  assert.notStrictEqual(
    deriveAtomicTransactionId("eng", [first, entry("ENG-2", "Changed")], plan),
    id,
    "changed desired state starts a fresh transaction",
  );
  // Changed mutation targets cannot collide with an incompatible recovery journal.
  assert.notStrictEqual(
    deriveAtomicTransactionId("eng", [first, second], [
      { ...plan[0]!, id: "other-prefix-first" },
      plan[1]!,
    ]),
    id,
    "changed mutation targets cannot collide with an incompatible recovery journal",
  );
  // Team change starts a fresh transaction.
  assert.notStrictEqual(
    deriveAtomicTransactionId("BACKEND", [first, second], plan),
    id,
    "a different team starts a fresh transaction",
  );
});

test("create ids are stable external-key ids and mutation planning handles transitions", () => {
  const id = deriveAtomicItemId("ENG", "ENG-42", "test-", fakeNormalize);
  assert.strictEqual(id, deriveAtomicItemId("eng", "ENG-42", "test-", fakeNormalize));
  assert.notStrictEqual(id, deriveAtomicItemId("ENG", "ENG-43", "test-", fakeNormalize));

  const created = buildAtomicImportMutations("ENG", entry("ENG-42", "New"), "test-", fakeNormalize);
  assert.strictEqual(created.itemId, id);
  assert.deepStrictEqual(created.mutations.map((mutation) => mutation.op), ["create", "update"]);

  // A partially-created deterministic item reproduces the original journal plan
  // (essential for crash recovery: the provenance scan finds the item, but the
  // SDK must still receive the original create+update upsert plan).
  const recoveredCreate = buildAtomicImportMutations(
    "ENG",
    entry("ENG-42", "New", { match: { id, status: "open" } }),
    "test-",
    fakeNormalize,
  );
  assert.deepStrictEqual(
    recoveredCreate.mutations,
    created.mutations,
    "a partially-created deterministic item reproduces the original journal plan",
  );

  // A closed new issue: create(open) + update + close.
  const closedNew = buildAtomicImportMutations(
    "ENG",
    entry("ENG-42", "Closed new", { status: "closed" }),
    "test-",
    fakeNormalize,
  );
  assert.deepStrictEqual(
    closedNew.mutations.map((mutation) => mutation.op),
    ["create", "update", "close"],
  );
  // The create seeds a valid OPEN item (the close step owns the transition);
  // the intermediate update must not re-assert a status.
  const closedNewCreate = closedNew.mutations.find((m) => m.op === "create") as
    | { options: Record<string, unknown> }
    | undefined;
  assert.strictEqual(
    closedNewCreate?.options.status,
    "open",
    "a closed new item is created open; the close step performs the transition",
  );
  const closedNewUpdate = closedNew.mutations.find((m) => m.op === "update") as
    | { options: Record<string, unknown> }
    | undefined;
  assert.ok(
    closedNewUpdate && !("status" in closedNewUpdate.options),
    "the update for a closed new item must not carry status",
  );

  // An existing legacy item closed upstream: update + close (no create).
  const closed = buildAtomicImportMutations(
    "ENG",
    entry("ENG-42", "Closed", { status: "closed", match: { id: "legacy-import-id", status: "open" } }),
    "test-",
    fakeNormalize,
  );
  assert.deepStrictEqual(closed.mutations.map((mutation) => mutation.op), ["update", "close"]);
  // Regression guard (Gemini review): the update for an already-closed upstream
  // item must NOT carry `status`. Carrying `status: "open"` would reopen the
  // existing item before the close step re-closes it — churning notifications,
  // activity logs, and webhooks on every sync.
  const closedUpdate = closed.mutations.find((m) => m.op === "update") as
    | { options: Record<string, unknown> }
    | undefined;
  assert.ok(closedUpdate, "closed existing item still issues an update for its fields");
  assert.ok(
    closedUpdate && !("status" in closedUpdate.options),
    "the update for a closed upstream item must not carry status (no reopen churn)",
  );

  // An existing legacy item reopened: a single update carrying the new status.
  const reopened = buildAtomicImportMutations(
    "ENG",
    entry("ENG-42", "Reopened", { match: { id: "legacy-import-id", status: "closed" } }),
    "test-",
    fakeNormalize,
  );
  assert.strictEqual(reopened.mutations.length, 1);
  assert.strictEqual(reopened.mutations[0]?.op, "update");
  assert.strictEqual(
    (reopened.mutations[0] as { options: Record<string, unknown> }).options.status,
    "open",
  );
});

// ---------------------------------------------------------------------------
// 4. --atomic --dry-run → shared prep path, correct counts, NO SDK commit call
// ---------------------------------------------------------------------------
test("atomic dry-run shares the prep path, reports counts, and never commits", async () => {
  const root = freshTracker();
  await importLinearForwardOnly(root, "ENG", [entry("ENG-2", "Original")]);
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  let sdkCalls = 0;
  try {
    // stateFilter "progress" matches the In Progress issues but excludes the
    // completed one, so ENG-3 is dropped by the state backstop (skipped=1).
    const result = await syncLinearIssues(
      { team: "ENG", limit: 100, atomic: true, forwardOnly: true, dryRun: true, stateFilter: "progress" },
      root,
      {
        fetchIssues: async () => [
          makeIssue("ENG-1", "New"),
          makeIssue("ENG-2", "Existing"),
          makeIssue("ENG-3", "Skipped", { stateName: "Done", stateType: "completed" }),
        ],
        commitAtomic: async () => {
          sdkCalls++;
          throw new Error("atomic dry-run must not call the SDK commit path");
        },
      },
    );

    assert.strictEqual(result.atomic, false);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.created, 1, "one new issue would be created");
    assert.strictEqual(result.updated, 1, "one existing issue would be updated");
    assert.strictEqual(result.skipped, 1, "the completed issue is skipped by the state backstop");
    assert.strictEqual(sdkCalls, 0, "dry-run must never invoke the SDK commit");
    assert.ok(
      messages.some((m) => /Forward-only plan: 1 creates, 1 updates, 1 skipped/.test(m)),
      `expected an atomic dry-run summary; got: ${messages.join(" | ")}`,
    );
  } finally {
    console.error = originalError; fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. all-skipped non-dry atomic import → SUCCESS zero-sync (legacy parity),
//    before commit
// ---------------------------------------------------------------------------
test("atomic all-skipped imports succeed with a zero-sync result before commit", async () => {
  let sdkCalls = 0;
  // Every fetched issue is dropped by the state backstop filter, so the
  // prepared set is empty. Filtered-out issues are an expected, common state
  // for a scheduled sync (not failures), so the atomic path must return a
  // successful zero-sync result — matching the legacy non-atomic path, which
  // never errors on an all-filtered batch — WITHOUT touching the SDK commit.
  const result = await syncLinearIssues(
    { team: "ENG", limit: 100, atomic: true, forwardOnly: true, stateFilter: "nonexistent-state" },
    "/unused-all-skipped-workspace",
    {
      fetchIssues: async () => [
        makeIssue("ENG-1", "Filtered out", { stateName: "In Progress", stateType: "started" }),
      ],
      readItems: () => [],
      commitAtomic: async () => {
        sdkCalls++;
        throw new Error("must not commit an empty plan");
      },
    },
  );
  assert.strictEqual(result.synced, 0);
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.skipped, 1, "the filtered issue is counted as skipped, not failed");
  assert.strictEqual(result.atomic, false);
  assert.strictEqual(sdkCalls, 0, "an all-skipped atomic import never reaches the SDK commit");
});

// ---------------------------------------------------------------------------
// 6. transaction id changes when a mutation target changes
// ---------------------------------------------------------------------------
test("transaction id changes when a mutation target changes", () => {
  const e1 = entry("ENG-1", "First");
  const e2 = entry("ENG-2", "Second");
  const basePlan = [
    { op: "update" as const, id: "pm-a", options: { title: "First" } },
    { op: "update" as const, id: "pm-b", options: { title: "Second" } },
  ];
  const baseId = deriveAtomicTransactionId("ENG", [e1, e2], basePlan);

  // Same content, same targets → identical id (order independent).
  assert.strictEqual(
    deriveAtomicTransactionId("ENG", [e2, e1], basePlan),
    baseId,
  );

  // A changed mutation target (different id) → fresh id.
  const retargeted = [
    { op: "update" as const, id: "pm-a", options: { title: "First" } },
    { op: "update" as const, id: "pm-changed", options: { title: "Second" } },
  ];
  assert.notStrictEqual(
    deriveAtomicTransactionId("ENG", [e1, e2], retargeted),
    baseId,
    "a changed mutation target yields a fresh transaction id",
  );

  // A changed id_prefix changes the derived managed id (and thus the mutation
  // plan targets), so the transaction id changes too.
  const prefixA = buildAtomicImportMutations("ENG", e1, "pm-", fakeNormalize);
  const prefixB = buildAtomicImportMutations("ENG", e1, "custom-", fakeNormalize);
  assert.notStrictEqual(prefixA.itemId, prefixB.itemId);
  assert.notStrictEqual(
    deriveAtomicTransactionId("ENG", [e1], prefixA.mutations),
    deriveAtomicTransactionId("ENG", [e1], prefixB.mutations),
    "a changed id_prefix changes the mutation targets and the transaction id",
  );

  // A changed status on an entry changes the canonical content → fresh id.
  const closedPlan = buildAtomicImportMutations(
    "ENG",
    entry("ENG-1", "First", { status: "closed" }),
    "pm-",
    fakeNormalize,
  ).mutations;
  assert.notStrictEqual(
    deriveAtomicTransactionId("ENG", [entry("ENG-1", "First", { status: "closed" })], closedPlan),
    deriveAtomicTransactionId("ENG", [e1], prefixA.mutations),
    "a changed status changes canonical content and the transaction id",
  );
});

// ---------------------------------------------------------------------------
// incomplete compensation is reported as potentially partial and resumable
// ---------------------------------------------------------------------------
test("forward import isolates a native failure without invoking a rollback seam", async () => {
  const root = freshTracker();
  try {
    let invoked = false;
    const result = await importLinearForwardOnly(root, "ENG", [entry("ENG-50", "Invalid", { status: "invalid-status" }), entry("ENG-51", "Independent")], {
      commitItemMutations: async () => { invoked = true; throw new AggregateError([], "Rollback must never run"); },
    });
    assert.equal(invoked, false); assert.equal(result.imported, 1); assert.equal(result.skipped, 1);
    assert.equal(result.importResults?.[0].code, "import_failed"); assert.equal(itemCount(root), 1); assert.equal(listItems(root)[0].title, "Independent");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("atomic update and close commit together", async () => {
  const root = freshTracker();
  try {
    const initial = entry("ENG-7", "Initial");
    const created = await importLinearForwardOnly(root, "ENG", [initial]);
    const itemId = created.itemIds.get("ENG-7");
    assert.ok(itemId);

    const changed = entry("ENG-7", "Completed upstream", {
      status: "closed",
      body: "Final body",
      match: { id: itemId, status: "open" },
    });
    const result = await importLinearForwardOnly(root, "ENG", [changed]);
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.updated, 1);
    const item = listItems(root).find((candidate) => candidate.id === itemId);
    assert.strictEqual(item?.title, "Completed upstream");
    assert.strictEqual(item?.status, "closed");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a hard settings read fault aborts before commit (never forks tx identity)
// ---------------------------------------------------------------------------
test("a settings read fault aborts before commit rather than forking identity", async () => {
  let sdkCalls = 0;
  // readSettings resolves a missing/malformed settings file to defaults WITHOUT
  // throwing, so a thrown error is a genuine fault (e.g. EACCES/EIO). Because
  // both the managed item ids and the durable transaction id are derived from
  // id_prefix, silently falling back to "pm-" here would fork a retry's
  // identity from the original run and could duplicate every item. The atomic
  // path must abort loudly BEFORE any SDK commit instead.
  await assert.rejects(
    () =>
      importLinearForwardOnly(
        "/unused-settings-fault-workspace",
        "ENG",
        [entry("ENG-60", "Needs prefix")],
        {
          commitItemMutations: async () => {
            sdkCalls++;
            throw new Error("commit must not run when settings cannot be read");
          },
          normalizeItemId: fakeNormalize,
          readSettings: async () => {
            const err = new Error(
              "EACCES: permission denied, open settings.json",
            ) as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          },
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.match((err as Error).message, /could not read workspace settings/i);
      assert.match((err as Error).message, /id_prefix/);
      return true;
    },
  );
  assert.strictEqual(sdkCalls, 0, "a settings fault must abort before any SDK commit");
});

// ---------------------------------------------------------------------------
// the linear-sync importer honors --dry-run (never turns a preview into a write)
// ---------------------------------------------------------------------------
// Activated once through pm's REAL engine via createExtensionTestHarness so the
// importer is exercised through real dispatch (runImporter), not a hand-rolled
// api double that registers the handler and then never evaluates it.
let atomicHarness: ExtensionTestHarness | undefined;
async function getAtomicHarness(): Promise<ExtensionTestHarness> {
  if (!atomicHarness) {
    atomicHarness = await createExtensionTestHarness(extension, {
      name: "pm-linear",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
    assert.deepEqual(atomicHarness.activation.failed, [], "activation must not fail");
  }
  return atomicHarness;
}

test("linear-sync importer honors --dry-run and never writes", async () => {
  const harness = await getAtomicHarness();
  const root = freshTracker();
  try {
    // Plain --dry-run must take the offline preview path: no network, and no
    // workspace write. Before the fix, the importer dropped dryRun and fell
    // through to syncLinearIssues, which writes one pm item per issue.
    const { result } = await harness.runImporter({
      importer: "linear-sync",
      options: { team: "ENG", "dry-run": true },
      pmRoot: root,
    });
    assert.strictEqual((result as any).dryRun, true, "dry-run result must be flagged");
    assert.strictEqual(
      itemCount(root),
      0,
      "a --dry-run linear-sync import must not write any items",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
