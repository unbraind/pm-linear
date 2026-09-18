/**
 * Behavioural tests for the pm-linear command/importer/exporter handlers and
 * the remaining sync/atomic branches.
 *
 * Handlers are driven through pm's real dispatch engine
 * (`createExtensionTestHarness` -> `runCommand`/`runImporter`/`runExporter`),
 * not a hand-rolled api double. Network-reaching paths point the Linear client
 * at a local `node:http` server (see `network.test.ts`) via
 * `LINEAR_API_BASE_URL`; offline paths run against a real `pm` workspace
 * created under `mkdtempSync(join(tmpdir(), "pm-linear-"))`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExtensionTestHarness,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

import extension, {
  CommandError,
  EXIT_CODE,
  commandNeedsLinearAccess,
  importLinearAtomic,
  syncLinearIssues,
  type LinearIssue,
} from "../index.ts";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

/** Create a fresh real pm workspace under tmpdir and return its root. */
function freshWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-cmd-"));
  const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
  assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
  return root;
}

/** Count items in a real pm workspace via `pm list-all --json`. */
function itemCount(root: string): number {
  const result = spawnSync(
    PM_BIN,
    ["--path", root, "list-all", "--json", "--full", "--limit", "100"],
    PM_SPAWN_OPTS,
  );
  assert.strictEqual(result.status, 0, `pm list-all failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { items?: unknown[] };
  return parsed.items?.length ?? 0;
}

/** A scoped environment block: set env vars, run, then restore the originals. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/** Build a Linear issue node in the shape the issues query selects. */
function issue(identifier: string, overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: `uuid-${identifier.toLowerCase()}`,
    identifier,
    title: `Title ${identifier}`,
    description: `Body ${identifier}`,
    priority: 2,
    estimate: null,
    state: { name: "In Progress", type: "started" },
    labels: { nodes: [{ name: "bug" }] },
    assignee: null,
    dueDate: null,
    cycle: null,
    project: null,
    customer: null,
    url: `https://linear.app/issue/${identifier}`,
    ...overrides,
  };
}

/** Build a minimal PreparedLinearImport entry for the atomic SDK seams. */
function preparedEntry(identifier: string): { identifier: string; linearId: string; title: string; status: string; priority: number; description: string; body: string; tags: string[] } {
  return {
    identifier,
    linearId: `uuid-${identifier.toLowerCase()}`,
    title: `Title ${identifier}`,
    status: "open",
    priority: 2,
    description: `[linear] linear_id=uuid-${identifier.toLowerCase()} linear_url=https://linear.app/issue/${identifier}`,
    body: `Body ${identifier}`,
    tags: ["bug"],
  };
}
/** Wrap an issues-node array in the GraphQL `data.issues` connection envelope. */
function issuesPage(nodes: LinearIssue[]): string {
  return JSON.stringify({
    data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
  });
}

interface LinearServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Start a local Linear-shaped server returning one issues page for any query. */
async function issuesServer(): Promise<LinearServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(issuesPage([issue("ENG-1"), issue("ENG-2")]));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server not listening");
  return {
    url: "http://127.0.0.1:" + addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let cmdHarness: ExtensionTestHarness | undefined;
async function getHarness(): Promise<ExtensionTestHarness> {
  if (!cmdHarness) {
    cmdHarness = await createExtensionTestHarness(extension, {
      name: "pm-linear",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
    assert.deepEqual(cmdHarness.activation.failed, [], "activation must not fail");
  }
  return cmdHarness;
}

// ---------------------------------------------------------------------------
// Option readers + classifier branches
// ---------------------------------------------------------------------------

test("readBooleanOption accepts string spellings through commandNeedsLinearAccess", () => {
  // The string branch of readBooleanOption is exercised through the classifier.
  assert.equal(commandNeedsLinearAccess("linear export", { push: "true" }), true);
  assert.equal(commandNeedsLinearAccess("linear export", { push: "1" }), true);
  assert.equal(commandNeedsLinearAccess("linear export", { push: "yes" }), true);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "true" }), false);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "" }), false);
  // A non-matching command falls through to the final false.
  assert.equal(commandNeedsLinearAccess("linear validate", {}), false);
  assert.equal(commandNeedsLinearAccess("linear list", { push: true }), false);
});

test("syncLinearIssues without LINEAR_API_KEY or a fetch seam throws USAGE", async () => {
  await withEnv({ LINEAR_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => syncLinearIssues({ team: "ENG", limit: 10 }, "/no/such/root"),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.equal((err as CommandError).exitCode, EXIT_CODE.USAGE);
        assert.match((err as Error).message, /LINEAR_API_KEY environment variable is not set/);
        return true;
      },
    );
  });
});

test("syncLinearIssues reaches the https request branch for an https endpoint", async () => {
  // No server: an https request to a dead port fails fast with a connection
  // error, exercising the https.request branch (useTls true) end to end.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-cmd-"));
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: "https://127.0.0.1:1/graphql" },
      async () => {
        await assert.rejects(
          () => syncLinearIssues({ team: "ENG", limit: 10 }, root),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.match((err as Error).message, /Linear request failed: /);
            return true;
          },
        );
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// syncLinearIssues atomic path: dry-run, all-skipped, recovered, cycle filter
// ---------------------------------------------------------------------------

test("syncLinearIssues --atomic --dry-run reports a plan without committing", async () => {
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      const result = await syncLinearIssues(
        { team: "ENG", limit: 100, atomic: true, dryRun: true },
        root,
        { fetchIssues: async () => [issue("ENG-1")] },
      );
      assert.equal(result.atomic, true);
      assert.equal(result.dryRun, true);
      assert.equal(result.created, 1);
      assert.equal(result.updated, 0);
      assert.equal(itemCount(root), 0, "dry-run writes nothing");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues --atomic returns a zero result when every issue is filtered out", async () => {
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      const result = await syncLinearIssues(
        { team: "ENG", limit: 100, atomic: true, stateFilter: "Nonexistent" },
        root,
        { fetchIssues: async () => [issue("ENG-1", { state: { name: "In Progress", type: "started" } })] },
      );
      assert.equal(result.atomic, true);
      assert.equal(result.synced, 0);
      assert.equal(result.skipped, 1);
      assert.equal(itemCount(root), 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues --atomic skips issues dropped by the --cycle backstop", async () => {
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      const result = await syncLinearIssues(
        { team: "ENG", limit: 100, atomic: true, cycleFilter: "Sprint" },
        root,
        {
          fetchIssues: async () => [
            issue("ENG-1", { cycle: { name: "Sprint 7" } }),
            issue("ENG-2", { cycle: null }),
          ],
          commitAtomic: async () => ({
            transactionId: "t1",
            recovered: false,
            imported: 1,
            updated: 0,
            itemIds: new Map([["ENG-1", "pm-1"]]),
          }),
        },
      );
      assert.equal(result.synced, 1);
      assert.equal(result.skipped, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues --atomic reports a recovered transaction separately", async () => {
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      const result = await syncLinearIssues(
        { team: "ENG", limit: 100, atomic: true },
        root,
        {
          fetchIssues: async () => [issue("ENG-1")],
          commitAtomic: async () => ({
            transactionId: "t-rec",
            recovered: true,
            imported: 0,
            updated: 0,
            recoveredItems: 1,
            itemIds: new Map([["ENG-1", "pm-1"]]),
          }),
        },
      );
      assert.equal(result.atomic, true);
      assert.equal(result.recovered, true);
      assert.equal(result.recoveredItems, 1);
      assert.equal(result.transactionId, "t-rec");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues legacy create/update failures skip the issue and continue", async () => {
  // A status-map mapping to an invalid pm status makes `pm create`/`pm update`
  // exit non-zero, exercising the per-issue spawn-failure skip branch.
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      const result = await syncLinearIssues(
        {
          team: "ENG",
          limit: 100,
          statusMap: { "In Progress": "NOSUCHSTATUS_XYZ" },
        },
        root,
        { fetchIssues: async () => [issue("ENG-1", { state: { name: "In Progress", type: "started" } })] },
      );
      assert.equal(result.created, 0, "the invalid-status create failed and was skipped");
      assert.equal(result.skipped, 1);
    });
    // Update failure: import one item first, then re-sync with the bad status.
    await withEnv({ LINEAR_API_KEY: "lin_test" }, async () => {
      await syncLinearIssues({ team: "ENG", limit: 100 }, root, {
        fetchIssues: async () => [issue("ENG-1")],
      });
      const result = await syncLinearIssues(
        {
          team: "ENG",
          limit: 100,
          statusMap: { "In Progress": "NOSUCHSTATUS_XYZ" },
        },
        root,
        { fetchIssues: async () => [issue("ENG-1", { state: { name: "In Progress", type: "started" } })] },
      );
      assert.equal(result.updated, 0, "the invalid-status update failed and was skipped");
      assert.equal(result.skipped, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// importLinearAtomic defensive SDK branches
// ---------------------------------------------------------------------------

test("importLinearAtomic throws USAGE when the SDK lacks commitItemMutations", async () => {
  const root = freshWorkspace();
  try {
    await assert.rejects(
      () =>
        importLinearAtomic(root, "ENG", [preparedEntry("ENG-1")], {
          sdkLoader: async () => ({}),
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match((err as Error).message, /does not export commitItemMutations/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importLinearAtomic throws USAGE when the SDK cannot be imported", async () => {
  const root = freshWorkspace();
  try {
    await assert.rejects(
      () =>
        importLinearAtomic(root, "ENG", [preparedEntry("ENG-1")], {
          sdkLoader: async () => {
            throw new Error("module not found");
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match((err as Error).message, /SDK could not be imported: module not found/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importLinearAtomic surfaces a WorkspaceTransactionInterruptedError as resumable", async () => {
  const root = freshWorkspace();
  try {
    const interrupted = new Error("journal paused");
    interrupted.name = "WorkspaceTransactionInterruptedError";
    await assert.rejects(
      () =>
        importLinearAtomic(root, "ENG", [preparedEntry("ENG-1")], {
          commitItemMutations: async () => Promise.reject(interrupted),
          normalizeItemId: (input: string, prefix: string) => `${prefix}${input.toLowerCase()}`,
          readSettings: async () => ({ id_prefix: "pm-" }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match((err as Error).message, /Atomic Linear import was interrupted/);
        assert.match((err as Error).message, /resumable/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readPmItems failure branches (status non-zero + spawn error)
// ---------------------------------------------------------------------------

test("readPmItems surfaces a non-zero pm list exit as a CommandError (export preview)", async () => {
  const harness = await getHarness();
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-cmd-"));
  try {
    await assert.rejects(
      () => harness.runExporter({ exporter: "linear", options: {}, pmRoot: badRoot }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match((err as Error).message, /tracker_/);
        return true;
      },
    );
  } finally {
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
});

test("readPmItems surfaces a spawn failure when pm is not on PATH", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  const savedPath = process.env["PATH"];
  try {
    delete process.env["PATH"];
    await assert.rejects(
      () => harness.runExporter({ exporter: "linear", options: {}, pmRoot: root }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match((err as Error).message, /pm list failed: /);
        return true;
      },
    );
  } finally {
    process.env["PATH"] = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildImportDryRunPlan tolerates a pm read failure and reports zero linked items", async () => {
  // A sync --dry-run against a non-workspace root must still succeed: the dry-
  // run plan catches the readPmItems failure and reports existingLinkedItems=0.
  const harness = await getHarness();
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-cmd-"));
  try {
    const { result } = await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true },
      pmRoot: badRoot,
      global: { json: true },
    });
    const plan = result as { dryRun: boolean; existingLinkedItems: number };
    assert.equal(plan.dryRun, true);
    assert.equal(plan.existingLinkedItems, 0);
  } finally {
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linear sync command handler
// ---------------------------------------------------------------------------

test("linear sync without a team throws USAGE", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
      await assert.rejects(
        () => harness.runCommand({ command: "linear sync", options: {}, pmRoot: root, global: { json: true } }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /Missing Linear team/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync --dry-run prints the human preview and the project-map boolean option", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const { result } = await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": true },
      pmRoot: root,
    });
    const plan = result as { dryRun: boolean; projectMap: { enabled: boolean; passthrough: boolean } };
    assert.equal(plan.dryRun, true);
    assert.equal(plan.projectMap.enabled, true, "bare --project-map boolean enables passthrough");
    assert.equal(plan.projectMap.passthrough, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync --dry-run with an env team logs the default-team message", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_DEFAULT_TEAM: "ENG" }, async () => {
      const { result } = await harness.runCommand({
        command: "linear sync",
        options: { "dry-run": true },
        pmRoot: root,
      });
      const plan = result as { dryRun: boolean; teamSource: string };
      assert.equal(plan.dryRun, true);
      assert.equal(plan.teamSource, "env");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync writes items through the real fetch and prints a summary (env team)", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await harness_runCommand_json(await getHarness(), {
          command: "linear sync",
          options: {},
          pmRoot: root,
        });
        const r = result as { synced: number; created: number; teamSource: string; team: string };
        assert.equal(r.synced, 2);
        assert.equal(r.created, 2);
        assert.equal(r.teamSource, "env");
        assert.equal(r.team, "ENG");
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync reports skipped issues in the summary (state filter)", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness_runCommand_json(await getHarness(), {
          command: "linear sync",
          options: { team: "ENG", state: "Nonexistent" },
          pmRoot: root,
        });
        const r = result as { synced: number; skipped: number };
        assert.equal(r.synced, 0);
        assert.equal(r.skipped, 2);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync --atomic commits through the real SDK and returns the atomic result", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness_runCommand_json(await getHarness(), {
          command: "linear sync",
          options: { team: "ENG", atomic: true },
          pmRoot: root,
        });
        const r = result as { atomic: boolean; synced: number; transactionId: string };
        assert.equal(r.atomic, true);
        assert.equal(r.synced, 2);
        assert.match(r.transactionId, /^linear-import-/);
      },
    );
    assert.equal(itemCount(root), 2, "atomic commit wrote the items");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linear import importer handler
// ---------------------------------------------------------------------------

test("linear import without a team throws USAGE", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
      await assert.rejects(
        () => harness.runImporter({ importer: "linear", options: {}, pmRoot: root, global: { json: true } }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /Missing Linear team/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear import --dry-run returns the offline plan", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const { result } = await harness.runImporter({
      importer: "linear",
      options: { team: "ENG", "dry-run": true },
      pmRoot: root,
      global: { json: true },
    });
    const r = result as { imported: number; dryRun: boolean };
    assert.equal(r.dryRun, true);
    assert.equal(r.imported, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear import writes items through the real fetch", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear",
          options: { team: "ENG" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { imported: number; created: number };
        assert.equal(r.imported, 2);
        assert.equal(r.created, 2);
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear import non-json reports skipped issues in its human summary", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear",
          options: { team: "ENG", state: "never-matches" },
          pmRoot: root,
          global: { json: false },
        });
        const r = result as { imported: number; skipped: number };
        assert.equal(r.imported, 0);
        assert.equal(r.skipped, 2);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear import --atomic commits through the real SDK", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear",
          options: { team: "ENG", atomic: true },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { atomic: boolean; imported: number; transactionId: string };
        assert.equal(r.atomic, true);
        assert.equal(r.imported, 2);
        assert.match(r.transactionId, /^linear-import-/);
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linear validate command handler (non-json + check-network)
// ---------------------------------------------------------------------------

test("linear validate --check-network prints the human reachability line", async () => {
  const server = await viewerServer();
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
          pmRoot: root,
        });
        const diag = result as { networkChecked: boolean; networkOk: boolean };
        assert.equal(diag.networkChecked, true);
        assert.equal(diag.networkOk, true);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linear export handler: preview, dry-run, push guards, update failure
// ---------------------------------------------------------------------------

test("linear export default preview returns the printable payloads (json)", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Preview me", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    const { result } = await harness.runExporter({
      exporter: "linear",
      options: { team: "ENG" },
      pmRoot: root,
      global: { json: true },
    });
    const r = result as { exported: number; pushed: boolean; wouldCreate: number; payloads: Array<{ action: string; title: string }> };
    assert.equal(r.pushed, false);
    assert.equal(r.exported, 1);
    assert.equal(r.wouldCreate, 1);
    assert.equal(r.payloads[0].action, "create");
    assert.equal(r.payloads[0].title, "Preview me");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export default preview without a team warns about create placeholders (non-json)", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "No team", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
      const { result } = await harness.runExporter({
        exporter: "linear",
        options: {},
        pmRoot: root,
      });
      const r = result as { exported: number; wouldCreate: number };
      assert.equal(r.exported, 1);
      assert.equal(r.wouldCreate, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --dry-run prints the would-be mutations (non-json)", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Dry run", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    const { result } = await harness.runExporter({
      exporter: "linear",
      options: { "dry-run": true, team: "ENG" },
      pmRoot: root,
    });
    const r = result as { dryRun: boolean; pushed: boolean; wouldCreate: number; mutations: unknown[] };
    assert.equal(r.dryRun, true);
    assert.equal(r.pushed, false);
    assert.equal(r.wouldCreate, 1);
    assert.equal(r.mutations.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --dry-run without a team warns about create placeholders", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Dry no team", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
      const { result } = await harness.runExporter({
        exporter: "linear",
        options: { "dry-run": true },
        pmRoot: root,
      });
      const r = result as { dryRun: boolean; wouldCreate: number };
      assert.equal(r.dryRun, true);
      assert.equal(r.wouldCreate, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --push without LINEAR_API_KEY throws USAGE", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: undefined }, async () => {
      await assert.rejects(
        () => harness.runExporter({ exporter: "linear", options: { push: true, team: "ENG" }, pmRoot: root }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /--push requires LINEAR_API_KEY/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --push with a key but no team throws USAGE", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test", LINEAR_DEFAULT_TEAM: undefined }, async () => {
      await assert.rejects(
        () => harness.runExporter({ exporter: "linear", options: { push: true }, pmRoot: root }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /--push requires --team/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --push with an env team logs the default-team message and pushes", async () => {
  const server = await issuesServerTeamPush();
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Env push", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true },
          pmRoot: root,
        });
        const r = result as { pushed: boolean; created: number; team: string; teamSource: string };
        assert.equal(r.pushed, true);
        assert.equal(r.created, 1);
        assert.equal(r.team, "ENG");
        assert.equal(r.teamSource, "env");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --push isolates an issueUpdate mutation failure and continues", async () => {
  // Import one item (linked), then push with a server that returns a GraphQL
  // error for every mutation; the linked item's update fails and is skipped.
  const server = await issuesServerTeamPushErrors();
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await syncLinearIssues({ team: "ENG", limit: 100 }, root, {
          fetchIssues: async () => [issue("ENG-1")],
        });
      },
    );
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { updated: number; skipped: number };
        assert.equal(r.updated, 0, "the linked update failed");
        assert.equal(r.skipped, 1, "the failed update was skipped, not aborted");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linear-sync importer handler
// ---------------------------------------------------------------------------

test("linear-sync import without a team throws USAGE", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
      await assert.rejects(
        () => harness.runImporter({ importer: "linear-sync", options: {}, pmRoot: root, global: { json: true } }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /linear-sync importer requires a 'team' option/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear-sync import writes items through the real fetch", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear-sync",
          options: { team: "ENG" },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { synced: number; created: number };
        assert.equal(r.synced, 2);
        assert.equal(r.created, 2);
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear-sync import --atomic commits through the real SDK", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear-sync",
          options: { team: "ENG", atomic: true },
          pmRoot: root,
          global: { json: true },
        });
        const r = result as { atomic: boolean; synced: number; transactionId: string };
        assert.equal(r.atomic, true);
        assert.equal(r.synced, 2);
        assert.match(r.transactionId, /^linear-import-/);
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers for the export-push servers
// ---------------------------------------------------------------------------

/** A local server that answers the viewer probe with a resolved viewer id. */
async function viewerServer(): Promise<LinearServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server not listening");
  return {
    url: "http://127.0.0.1:" + addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A local server that answers the team query and a successful create mutation. */
async function issuesServerTeamPush(): Promise<LinearServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("teams(")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: { teams: { nodes: [{ id: "team-1", states: { nodes: [] }, labels: { nodes: [] }, cycles: { nodes: [] } }] } },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "lin-1", identifier: "ENG-NEW", url: "https://linear.app/issue/ENG-NEW" } } } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server not listening");
  return {
    url: "http://127.0.0.1:" + addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A local server that answers the team query but returns a GraphQL error for every mutation. */
async function issuesServerTeamPushErrors(): Promise<LinearServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("teams(")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: { teams: { nodes: [{ id: "team-1", states: { nodes: [] }, labels: { nodes: [] }, cycles: { nodes: [] } }] } },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "update rejected" }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server not listening");
  return {
    url: "http://127.0.0.1:" + addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Run a command through the harness with json global mode and unwrap the result.
 *
 * The harness returns `{ handled, result, warnings }`; in json mode the handler
 * return value is the structured object we assert on.
 */
async function harness_runCommand_json(
  harness: ExtensionTestHarness,
  opts: { command: string; options: Record<string, unknown>; pmRoot: string },
): Promise<{ result: unknown }> {
  return harness.runCommand({
    command: opts.command,
    options: opts.options,
    pmRoot: opts.pmRoot,
    global: { json: true },
  });
}
// ---------------------------------------------------------------------------
// Non-JSON handler branches (the harness defaults to json:true; these opt out)
// ---------------------------------------------------------------------------

test("linear sync --dry-run prints the full human preview with maps (non-json, env team)", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_DEFAULT_TEAM: "ENG" }, async () => {
      // passthrough project map + status map + field map -> every preview line.
      const { result } = await harness.runCommand({
        command: "linear sync",
        options: { "dry-run": true, "project-map": true, "status-map": "In Progress=blocked", "map": "identifier=ignore" },
        pmRoot: root,
        global: { json: false },
      });
      const plan = result as { dryRun: boolean; projectMap: { passthrough: boolean } };
      assert.equal(plan.dryRun, true);
      assert.equal(plan.projectMap.passthrough, true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync --dry-run prints the explicit project map (non-json)", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const { result } = await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": "Mobile App=mobile" },
      pmRoot: root,
      global: { json: false },
    });
    const plan = result as { projectMap: { enabled: boolean; passthrough: boolean; map: Record<string, string> } };
    assert.equal(plan.projectMap.enabled, true);
    assert.equal(plan.projectMap.passthrough, false);
    assert.equal(plan.projectMap.map["mobile app"], "mobile");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync writes items non-json with an env team and logs the default-team message", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await (await getHarness()).runCommand({
          command: "linear sync",
          options: {},
          pmRoot: root,
          global: { json: false },
        });
        const r = result as { synced: number; teamSource: string };
        assert.equal(r.synced, 2);
        assert.equal(r.teamSource, "env");
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate --check-network prints the human reachability line (non-json)", async () => {
  const server = await viewerServer();
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
          pmRoot: root,
          global: { json: false },
        });
        const diag = result as { networkChecked: boolean; networkOk: boolean };
        assert.equal(diag.networkChecked, true);
        assert.equal(diag.networkOk, true);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear import writes items non-json with an env team and logs the default-team message", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear",
          options: {},
          pmRoot: root,
          global: { json: false },
        });
        const r = result as { imported: number; teamSource: string };
        assert.equal(r.imported, 2);
        assert.equal(r.teamSource, "env");
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export --push non-json with an env team logs the default-team message", async () => {
  const server = await issuesServerTeamPush();
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Env push nj", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true },
          pmRoot: root,
          global: { json: false },
        });
        const r = result as { pushed: boolean; created: number; teamSource: string };
        assert.equal(r.pushed, true);
        assert.equal(r.created, 1);
        assert.equal(r.teamSource, "env");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear-sync import non-json with an env team logs the default-team message", async () => {
  const server = await issuesServer();
  const root = freshWorkspace();
  const harness = await getHarness();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_DEFAULT_TEAM: "eng" },
      async () => {
        const { result } = await harness.runImporter({
          importer: "linear-sync",
          options: {},
          pmRoot: root,
          global: { json: false },
        });
        const r = result as { synced: number; teamSource: string };
        assert.equal(r.synced, 2);
        assert.equal(r.teamSource, "env");
      },
    );
    assert.equal(itemCount(root), 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
