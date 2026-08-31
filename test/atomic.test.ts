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
  importLinearAtomic,
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
test("a failed atomic batch compensates every applied create (reverse rollback)", async () => {
  const root = freshTracker();
  try {
    const sdk = await import("@unbrained/pm-cli/sdk");
    // Wrap the real SDK commit to append a guaranteed-to-fail create so the
    // whole transaction rolls back. This exercises the SDK's real reverse-
    // order compensation against the live tracker.
    const wrappingCommit = async (
      options: Parameters<typeof sdk.commitItemMutations>[0],
    ) => {
      const settings = await sdk.readSettings(options.pmRoot);
      const brokenId = sdk.normalizeItemId("linear-broken", settings.id_prefix);
      return sdk.commitItemMutations({
        ...options,
        mutations: [
          ...options.mutations,
          {
            op: "create" as const,
            id: brokenId,
            options: { title: "Broken", type: "NoSuchType_XYZ", status: "open" },
          },
        ],
      });
    };

    await assert.rejects(
      () =>
        importLinearAtomic(
          root,
          "ENG",
          [entry("ENG-20", "Rollback one"), entry("ENG-21", "Rollback two")],
          { commitItemMutations: wrappingCommit },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
        assert.match((err as Error).message, /no new partial committed state is expected/);
        return true;
      },
    );
    assert.strictEqual(itemCount(root), 0, "rollback deletes every transaction-owned create");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed mixed batch restores pre-existing updates and closes", async () => {
  const root = freshTracker();
  try {
    const sdk = await import("@unbrained/pm-cli/sdk");
    const initialEntries = [
      entry("ENG-30", "Original update target"),
      entry("ENG-31", "Original close target"),
    ];
    const initial = await importLinearAtomic(root, "ENG", initialEntries);
    const updateId = initial.itemIds.get("ENG-30");
    const closeId = initial.itemIds.get("ENG-31");
    assert.ok(updateId);
    assert.ok(closeId);

    const wrappingCommit = async (
      options: Parameters<typeof sdk.commitItemMutations>[0],
    ) => {
      const settings = await sdk.readSettings(options.pmRoot);
      const brokenId = sdk.normalizeItemId("linear-broken-mixed", settings.id_prefix);
      return sdk.commitItemMutations({
        ...options,
        mutations: [
          ...options.mutations,
          {
            op: "create" as const,
            id: brokenId,
            options: { title: "Broken", type: "NoSuchType_XYZ", status: "open" },
          },
        ],
      });
    };

    await assert.rejects(
      () =>
        importLinearAtomic(
          root,
          "ENG",
          [
            entry("ENG-30", "Mutated title", {
              body: "Mutated body",
              match: { id: updateId, status: "open" },
            }),
            entry("ENG-31", "Should be restored", {
              status: "closed",
              match: { id: closeId, status: "open" },
            }),
          ],
          { commitItemMutations: wrappingCommit },
        ),
      /no new partial committed state is expected/,
    );

    const items = listItems(root);
    const updateTarget = items.find((candidate) => candidate.id === updateId);
    const closeTarget = items.find((candidate) => candidate.id === closeId);
    assert.strictEqual(
      updateTarget?.title,
      "Original update target",
      "update compensation restores title",
    );
    assert.strictEqual(updateTarget?.status, "open", "update compensation restores status");
    assert.strictEqual(
      closeTarget?.title,
      "Original close target",
      "close target content is restored",
    );
    assert.strictEqual(closeTarget?.status, "open", "close compensation reopens the item");
    assert.strictEqual(
      itemCount(root),
      2,
      "mixed rollback neither deletes nor duplicates existing items",
    );
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. resume idempotence → re-running the same fetched set recovers the SAME
//    transaction, 0 duplicates
// ---------------------------------------------------------------------------
test("atomic import commits and resumes reordered input without duplicates", async () => {
  const root = freshTracker();
  try {
    const entries = [entry("ENG-1", "First"), entry("ENG-2", "Second")];
    const first = await importLinearAtomic(root, "ENG", entries);
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
    const resumed = await importLinearAtomic(root, "ENG", resumedEntries);
    assert.strictEqual(resumed.transactionId, first.transactionId);
    assert.strictEqual(resumed.recovered, true);
    assert.strictEqual(resumed.imported, 0, "a recovered journal is not misreported as new work");
    assert.strictEqual(resumed.updated, 0, "a recovered journal is not misreported as updates");
    assert.strictEqual(resumed.recoveredItems, 2);
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
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  let sdkCalls = 0;
  try {
    // stateFilter "progress" matches the In Progress issues but excludes the
    // completed one, so ENG-3 is dropped by the state backstop (skipped=1).
    const result = await syncLinearIssues(
      { team: "ENG", limit: 100, atomic: true, dryRun: true, stateFilter: "progress" },
      "/unused-dry-run-workspace",
      {
        fetchIssues: async () => [
          makeIssue("ENG-1", "New"),
          makeIssue("ENG-2", "Existing"),
          makeIssue("ENG-3", "Skipped", { stateName: "Done", stateType: "completed" }),
        ],
        readItems: () => [
          {
            id: "existing-id",
            description: entry("ENG-2", "Existing").description,
          },
        ],
        commitAtomic: async () => {
          sdkCalls++;
          throw new Error("atomic dry-run must not call the SDK commit path");
        },
      },
    );

    assert.strictEqual(result.atomic, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.created, 1, "one new issue would be created");
    assert.strictEqual(result.updated, 1, "one existing issue would be updated");
    assert.strictEqual(result.skipped, 1, "the completed issue is skipped by the state backstop");
    assert.strictEqual(sdkCalls, 0, "dry-run must never invoke the SDK commit");
    assert.ok(
      messages.some((m) => /Atomic plan would import 1, update 1, skip 1/.test(m)),
      `expected an atomic dry-run summary; got: ${messages.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
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
    { team: "ENG", limit: 100, atomic: true, stateFilter: "nonexistent-state" },
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
  assert.strictEqual(result.atomic, true);
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
test("incomplete compensation is reported as potentially partial and resumable", async () => {
  const incomplete = new AggregateError(
    [new Error("apply failed"), new Error("restore failed")],
    "Workspace transaction failed and compensation failed: restore failed",
  );
  await assert.rejects(
    () =>
      importLinearAtomic(
        "/unused-incomplete-compensation-workspace",
        "ENG",
        [entry("ENG-50", "Needs repair")],
        {
          commitItemMutations: async () => {
            throw incomplete;
          },
          normalizeItemId: fakeNormalize,
          readSettings: async () => ({ id_prefix: "test-" }),
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match((err as Error).message, /compensation was incomplete/);
      assert.match((err as Error).message, /may contain partially applied state/);
      assert.doesNotMatch((err as Error).message, /no new partial committed state/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// end-to-end commit through the real SDK against a live tracker
// ---------------------------------------------------------------------------
test("atomic update and close commit together", async () => {
  const root = freshTracker();
  try {
    const initial = entry("ENG-7", "Initial");
    const created = await importLinearAtomic(root, "ENG", [initial]);
    const itemId = created.itemIds.get("ENG-7");
    assert.ok(itemId);

    const changed = entry("ENG-7", "Completed upstream", {
      status: "closed",
      body: "Final body",
      match: { id: itemId, status: "open" },
    });
    const result = await importLinearAtomic(root, "ENG", [changed]);
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
      importLinearAtomic(
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
