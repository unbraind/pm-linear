import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import type { PreflightOverrideContext } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { CommandHandlerResult } from "@unbrained/pm-cli/sdk/authoring";

import extension, {
  CommandError,
  EXIT_CODE,
  buildAtomicImportMutations,
  buildExportMutationPlan,
  atomicReceiptFields,
  buildImportDryRunPlan,
  buildItemPlan,
  buildProvenance,
  commandNeedsLinearAccess,
  errorMessage,
  deriveAtomicTransactionId,
  importLinearAtomic,
  linearPreviewPriority,
  linearPreviewState,
  normalizeDueDate,
  parseFieldMap,
  parseProjectMap,
  parseProvenance,
  pushItemLabel,
  resolveStatus,
  syncLinearIssues,
  throwIfLinearErrors,
} from "../index.ts";
import type { LinearIssue, PreparedLinearImport } from "../index.ts";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = {
  encoding: "utf-8" as const,
  shell: process.platform === "win32",
};

const PREFLIGHT_ERROR_OPTION = "__linear_preflight_error";

interface LinearGraphqlPayload {
  query: string;
  variables: Record<string, unknown>;
}

interface FakeLinearResponse {
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
  timeout?: boolean;
  error?: unknown;
}

type LinearHandler = (payload: LinearGraphqlPayload) => FakeLinearResponse;

interface LinearIssueOverride {
  stateName?: string;
  stateType?: string;
  body?: string | null;
  cycleName?: string | null;
  projectName?: string | null;
  assigneeEmail?: string | null;
  assigneeName?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  labels?: string[];
  priority?: number;
}

function makeIssue(identifier: string, title: string, overrides: LinearIssueOverride = {}): LinearIssue {
  return {
    id: `uuid-${identifier.toLowerCase()}`,
    identifier,
    title,
    description: overrides.body === undefined ? `Body ${identifier}` : overrides.body,
    priority: overrides.priority ?? 2,
    estimate: overrides.estimate ?? null,
    state: {
      name: overrides.stateName ?? "In Progress",
      type: overrides.stateType ?? "started",
    },
    labels: { nodes: (overrides.labels ?? ["bug"]).map((name) => ({ name })) },
    assignee:
      overrides.assigneeEmail === null && overrides.assigneeName === null
        ? null
        : {
            name: overrides.assigneeName ?? "Dev",
            email: overrides.assigneeEmail ?? "dev@acme.com",
          },
    dueDate: overrides.dueDate === undefined ? null : overrides.dueDate,
    cycle: overrides.cycleName === null ? null : { name: overrides.cycleName ?? "Q3" },
    project: overrides.projectName === null ? null : { name: overrides.projectName ?? "Mobile" },
    customer: null,
    url: `https://linear.app/issue/${identifier}`,
  };
}

function issueNode(identifier: string, title: string, overrides: LinearIssueOverride = {}): Record<string, unknown> {
  const issue = makeIssue(identifier, title, overrides);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    estimate: issue.estimate,
    state: issue.state,
    labels: issue.labels,
    assignee: issue.assignee ?? null,
    dueDate: issue.dueDate,
    cycle: issue.cycle,
    project: issue.project ?? null,
    customer: issue.customer ?? null,
    url: issue.url,
  };
}

function graphqlOk(data: Record<string, unknown>): FakeLinearResponse {
  return { status: 200, body: JSON.stringify({ data }) };
}

function issuesPage(
  nodes: Record<string, unknown>[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): FakeLinearResponse {
  return graphqlOk({ issues: { nodes, pageInfo } });
}

function installHttpsStub(handler: LinearHandler): () => void {
  const original = https.request;
  const stub = ((
    _options: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      chunks: string[];
      write: (chunk: string | Buffer) => boolean;
      end: () => ClientRequest;
      destroy: (err?: Error) => ClientRequest;
    };
    req.chunks = [];
    req.write = (chunk: string | Buffer) => {
      req.chunks.push(String(chunk));
      return true;
    };
    req.destroy = (err?: Error) => {
      if (err) process.nextTick(() => req.emit("error", err));
      return req as unknown as ClientRequest;
    };
    req.end = () => {
      const payload = JSON.parse(req.chunks.join("")) as LinearGraphqlPayload;
      const fake = handler(payload);
      if (fake.timeout) {
        process.nextTick(() => req.emit("timeout"));
        return req as unknown as ClientRequest;
      }
      if (fake.error !== undefined) {
        process.nextTick(() => req.emit("error", fake.error));
        return req as unknown as ClientRequest;
      }
      const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        headers: Record<string, string | string[] | undefined>;
      };
      if (fake.status !== undefined) res.statusCode = fake.status;
      res.headers = fake.headers ?? {};
      process.nextTick(() => {
        callback?.(res as IncomingMessage);
        res.emit("data", Buffer.from(fake.body ?? ""));
        res.emit("end");
      });
      return req as unknown as ClientRequest;
    };
    return req as unknown as ClientRequest;
  }) as typeof https.request;
  https.request = stub;
  return () => {
    https.request = original;
  };
}

async function withHttps<T>(handler: LinearHandler, fn: () => Promise<T>): Promise<T> {
  const restore = installHttpsStub(handler);
  try {
    return await fn();
  } finally {
    restore();
  }
}

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; errors: string[]; logs: string[] }> {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values: unknown[]) => {
    errors.push(values.map((value) => String(value)).join(" "));
  };
  console.log = (...values: unknown[]) => {
    logs.push(values.map((value) => String(value)).join(" "));
  };
  try {
    return { value: await fn(), errors, logs };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-runtime-"));
  try {
    const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
    assert.equal(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function listItems(root: string): Array<{ id: string; title: string; status: string }> {
  const result = spawnSync(
    PM_BIN,
    ["--path", root, "list-all", "--json", "--full", "--limit", "100"],
    PM_SPAWN_OPTS,
  );
  assert.equal(result.status, 0, `pm list-all failed: ${result.error?.message ?? result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    items?: Array<{ id: string; title: string; status: string }>;
  };
  return parsed.items ?? [];
}

function createPmItem(
  root: string,
  args: string[],
): void {
  const result = spawnSync(PM_BIN, ["--path", root, "create", ...args], PM_SPAWN_OPTS);
  assert.equal(result.status, 0, `pm create failed: ${result.error?.message ?? result.stderr}`);
}

function fakeNormalize(input: string, prefix: string): string {
  const folded = input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = folded.length;
  while (start < end && folded[start] === "-") start++;
  while (end > start && folded[end - 1] === "-") end--;
  return `${prefix}${folded.slice(start, end)}`;
}

function preparedEntry(identifier: string, title: string): PreparedLinearImport {
  return {
    identifier,
    linearId: `uuid-${identifier.toLowerCase()}`,
    title,
    status: "open",
    priority: 3,
    description: buildProvenance({ id: `uuid-${identifier.toLowerCase()}`, identifier }),
    body: `Body ${identifier}`,
    tags: ["bug"],
  };
}

function payload(outcome: CommandHandlerResult): Record<string, unknown> {
  assert.equal(outcome.handled, true, outcome.errorMessage ?? "handler was not handled");
  assert.equal(typeof outcome.result, "object");
  assert.ok(outcome.result);
  return outcome.result as Record<string, unknown>;
}

function writeFakePm(mode: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-fake-pm-"));
  const script = `#!/usr/bin/env node
const mode = process.env.PM_LINEAR_FAKE_LIST || ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (!args.includes("list")) {
  process.stderr.write("unexpected " + args.join(" "));
  process.exit(2);
}
if (mode === "fail") {
  process.stderr.write("list exploded");
  process.exit(1);
}
if (mode === "fail-silent") {
  process.exit(1);
}
if (mode === "garbage") {
  process.stdout.write("{{{");
  process.exit(0);
}
const desc = process.env.PM_LINEAR_FAKE_DESC || "";
const item = { id: "pm-linked", title: "Linked", description: desc };
if (mode === "array") {
  process.stdout.write(JSON.stringify([item]));
  process.exit(0);
}
if (mode === "results") {
  process.stdout.write(JSON.stringify({ results: [item] }));
  process.exit(0);
}
if (mode === "empty") {
  process.stdout.write("{}");
  process.exit(0);
}
process.stderr.write("unknown mode " + mode);
process.exit(2);
`;
  const bin = path.join(dir, "pm");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return dir;
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

const preflightDecision = {
  enforce_item_format_gate: false,
  run_preflight_item_format_sync: false,
  run_extension_migrations: false,
  enforce_mandatory_migration_gate: false,
};

function preflightContext(
  command: string,
  options: Record<string, unknown>,
): PreflightOverrideContext {
  return {
    command,
    args: [],
    options,
    global: { json: true, quiet: true, noPager: true },
    pm_root: "",
    decision: preflightDecision,
  };
}

let runtimeHarness: ExtensionTestHarness | undefined;
async function getHarness(): Promise<ExtensionTestHarness> {
  if (!runtimeHarness) {
    runtimeHarness = await createExtensionTestHarness(extension, {
      name: "pm-linear",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
    assert.deepEqual(runtimeHarness.activation.failed, [], "activation must not fail");
  }
  return runtimeHarness;
}

test("commandNeedsLinearAccess treats unknown commands and string flag spellings", () => {
  assert.equal(commandNeedsLinearAccess("linear validate", {}), false);
  assert.equal(commandNeedsLinearAccess("LINEAR SYNC", { dryRun: "yes" }), false);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "true" }), false);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "1" }), false);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "" }), false);
  assert.equal(commandNeedsLinearAccess("linear sync", { "dry-run": "false" }), true);
  assert.equal(commandNeedsLinearAccess("linear export", { push: "TRUE", "dry-run": "0" }), true);
});

test("parseProjectMap still distinguishes a boolean project-map option at the command seam", async () => {
  const harness = await getHarness();
  const enabled = payload(
    await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": true },
    }),
  );
  const enabledMap = enabled.projectMap as { enabled: boolean; passthrough: boolean };
  assert.equal(enabledMap.enabled, true);
  assert.equal(enabledMap.passthrough, true);

  const disabled = payload(
    await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": false },
    }),
  );
  const disabledMap = disabled.projectMap as { enabled: boolean };
  assert.equal(disabledMap.enabled, false);

  const numeric = payload(
    await harness.runCommand({
      command: "linear sync",
      options: { team: 99, "dry-run": true, "project-map": 7, limit: "25" },
    }),
  );
  assert.equal(numeric.team, "99");
  const variables = (numeric.request as { variables: Record<string, unknown> }).variables;
  assert.equal(variables.first, 25);
  assert.equal(parseProjectMap("7").passthrough, true);

  const fallback = payload(
    await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, limit: "nope" },
    }),
  );
  assert.equal(
    (fallback.request as { variables: Record<string, unknown> }).variables.first,
    100,
  );

  const fromNull = payload(
    await harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, limit: null },
    }),
  );
  assert.equal(
    (fromNull.request as { variables: Record<string, unknown> }).variables.first,
    100,
  );
});

test("live fetch paginates, honors the limit, and surfaces GraphQL errors", async () => {
  await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
    let calls = 0;
    await withHttps((payload) => {
      calls += 1;
      assert.match(payload.query, /issues\(/);
      if (calls === 1) {
        assert.equal(payload.variables.after, null);
        return issuesPage([issueNode("ENG-1", "First")], {
          hasNextPage: true,
          endCursor: "cursor-1",
        });
      }
      assert.equal(payload.variables.after, "cursor-1");
      return issuesPage([issueNode("ENG-2", "Second"), issueNode("ENG-3", "Third")], {
        hasNextPage: true,
        endCursor: "cursor-2",
      });
    }, async () => {
      const captured = await captureLogs(() =>
        syncLinearIssues(
          { team: "ENG", limit: 2 },
          "/unused-pagination",
          { readItems: () => [] },
        ),
      );
      assert.equal(captured.value.created, 0);
      assert.equal(captured.value.skipped, 2);
      assert.equal(captured.value.issues.length, 2);
      assert.equal(captured.value.issues[0]?.identifier, "ENG-1");
      assert.equal(captured.value.issues[1]?.identifier, "ENG-2");
      assert.equal(calls, 2);
    });

    await withHttps(() => ({ status: 200, body: JSON.stringify({ errors: [{ message: "nope" }] }) }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 10 },
            "/unused-graphql-error",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /Linear API error: nope/);
          return true;
        },
      );
    });

    const empty = await withHttps(
      () => issuesPage([], { hasNextPage: true, endCursor: "unused" }),
      async () =>
        captureLogs(() =>
          syncLinearIssues(
            { team: "ENG", limit: 10 },
            "/unused-empty",
            { readItems: () => [] },
          ),
        ),
    );
    assert.equal(empty.value.synced, 0);
    assert.match(empty.errors.join("\n"), /No issues found for team "ENG"/);

    const noNodes = await withHttps(
      () => graphqlOk({ issues: { pageInfo: { hasNextPage: true, endCursor: "c" } } }),
      async () =>
        captureLogs(() =>
          syncLinearIssues(
            { team: "ENG", limit: 10 },
            "/unused-no-nodes",
            { readItems: () => [] },
          ),
        ),
    );
    assert.equal(noNodes.value.synced, 0);

    const noCursor = await withHttps(
      () => issuesPage([issueNode("ENG-1", "Only")], { hasNextPage: true, endCursor: null }),
      async () =>
        captureLogs(() =>
          syncLinearIssues(
            { team: "ENG", limit: 10 },
            "/unused-no-cursor",
            { readItems: () => [] },
          ),
        ),
    );
    assert.equal(noCursor.value.issues.length, 1);

    const noStatus = await withHttps(
      () => ({
        body: JSON.stringify({
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      }),
      async () =>
        captureLogs(() =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-no-status",
            { readItems: () => [] },
          ),
        ),
    );
    assert.equal(noStatus.value.synced, 0);
  });
});

test("the GraphQL client retries transient HTTP failures and refuses bad credentials", async () => {
  await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
    let retried = 0;
    const recovered = await withHttps((payload) => {
      if (payload.query.includes("viewer")) {
        return graphqlOk({ viewer: { id: "user-1" } });
      }
      retried += 1;
      if (retried === 1) {
        return { status: 429, body: "slow down" };
      }
      if (retried === 2) {
        return { status: 503, headers: { "retry-after": "0" }, body: "down" };
      }
      if (retried === 3) {
        return {
          status: 500,
          headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
          body: "old",
        };
      }
      if (retried === 4) {
        return { status: 502, headers: { "retry-after": "later" }, body: "nope" };
      }
      return issuesPage([issueNode("ENG-9", "Recovered")]);
    }, async () =>
      captureLogs(() =>
        syncLinearIssues(
          { team: "ENG", limit: 1 },
          "/unused-retry",
          { readItems: () => [] },
        ),
      ),
    );
    assert.equal(recovered.value.issues[0]?.identifier, "ENG-9");
    assert.ok(retried >= 5);

    await withHttps(() => ({ status: 401, body: "denied" }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-401",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.equal(err.exitCode, EXIT_CODE.USAGE);
          assert.match(err.message, /HTTP 401/);
          return true;
        },
      );
    });

    await withHttps(() => ({ status: 403, body: "denied" }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-403",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /HTTP 403/);
          return true;
        },
      );
    });

    await withHttps(() => ({ status: 200, body: "{" }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-parse",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /Failed to parse Linear response/);
          return true;
        },
      );
    });

    await withHttps(() => ({ error: "socket down" }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-network",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /Linear request failed: socket down/);
          return true;
        },
      );
    });

    let timeouts = 0;
    await withHttps(() => {
      timeouts += 1;
      if (timeouts === 1) return { timeout: true };
      return issuesPage([]);
    }, async () => {
      const captured = await captureLogs(() =>
        syncLinearIssues(
          { team: "ENG", limit: 1 },
          "/unused-timeout-once",
          { readItems: () => [] },
        ),
      );
      assert.equal(captured.value.synced, 0);
    });

    await withHttps(() => ({ timeout: true }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-timeout-all",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /Linear API unavailable after 5 attempts \(HTTP timeout\)/);
          return true;
        },
      );
    });

    await withHttps(() => ({ status: 429, headers: { "retry-after": "0" }, body: "no" }), async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-429-all",
            { readItems: () => [] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /HTTP 429/);
          return true;
        },
      );
    });
  });
});

test("readPmItems reports spawn, status, parse, and envelope shapes", async () => {
  const desc = buildProvenance({ id: "lin-array", identifier: "ENG-8" });
  const failDir = writeFakePm("fail");
  try {
    await withPath(failDir, async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-list-fail",
            { fetchIssues: async () => [makeIssue("ENG-8", "X")] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /list exploded/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(failDir, { recursive: true, force: true });
  }

  const silentDir = writeFakePm("fail-silent");
  try {
    await withPath(silentDir, async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-list-silent",
            { fetchIssues: async () => [makeIssue("ENG-8", "X")] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.equal(err.message, "pm list failed");
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(silentDir, { recursive: true, force: true });
  }

  const garbageDir = writeFakePm("garbage");
  try {
    await withPath(garbageDir, async () => {
      await assert.rejects(
        () =>
          syncLinearIssues(
            { team: "ENG", limit: 1 },
            "/unused-list-garbage",
            { fetchIssues: async () => [makeIssue("ENG-8", "X")] },
          ),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /Could not parse `pm list --json` output/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(garbageDir, { recursive: true, force: true });
  }

  const arrayDir = writeFakePm("array");
  try {
    const harness = await getHarness();
    const counted = await withEnv({ PM_LINEAR_FAKE_DESC: desc }, async () =>
      withPath(arrayDir, async () =>
        payload(
          await harness.runCommand({
            command: "linear sync",
            options: { team: "ENG", "dry-run": true },
            pmRoot: "/unused-array-envelope",
          }),
        ),
      ),
    );
    assert.equal(counted.existingLinkedItems, 1);
  } finally {
    fs.rmSync(arrayDir, { recursive: true, force: true });
  }

  const resultsDir = writeFakePm("results");
  try {
    const harness = await getHarness();
    const counted = await withEnv({ PM_LINEAR_FAKE_DESC: desc }, async () =>
      withPath(resultsDir, async () =>
        payload(
          await harness.runCommand({
            command: "linear sync",
            options: { team: "ENG", "dry-run": true },
            pmRoot: "/unused-results-envelope",
          }),
        ),
      ),
    );
    assert.equal(counted.existingLinkedItems, 1);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }

  const emptyDir = writeFakePm("empty");
  try {
    const harness = await getHarness();
    const counted = await withPath(emptyDir, async () =>
      payload(
        await harness.runCommand({
          command: "linear sync",
          options: { team: "ENG", "dry-run": true },
          pmRoot: "/unused-empty-envelope",
        }),
      ),
    );
    assert.equal(counted.existingLinkedItems, 0);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  const previousPath = process.env.PATH;
  process.env.PATH = "/this-path-has-no-pm-binary";
  try {
    await assert.rejects(
      () =>
        syncLinearIssues(
          { team: "ENG", limit: 1 },
          "/unused-enoent",
          { fetchIssues: async () => [makeIssue("ENG-8", "X")] },
        ),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /pm list failed:/);
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("import dry-run swallows a local list fault and prints the human plan", async () => {
  const harness = await getHarness();
  const captured = await withEnv({ LINEAR_DEFAULT_TEAM: "ops" }, async () =>
    captureLogs(() =>
      harness.runCommand({
        command: "linear sync",
        options: {
          "dry-run": true,
          state: "In Progress",
          cycle: "Sprint 7",
          project: "Mobile",
          "status-map": "In Progress=in_progress",
          map: "priority=ignore",
          "project-map": "Mobile=mobile",
        },
        global: { json: false },
        pmRoot: "/this-tracker-does-not-exist",
      }),
    ),
  );
  const body = payload(captured.value);
  assert.equal(body.existingLinkedItems, 0);
  assert.equal(body.teamSource, "env");
  const printed = captured.errors.join("\n");
  assert.match(printed, /Using LINEAR_DEFAULT_TEAM=OPS/);
  assert.match(printed, /Running in dry-run mode/);
  assert.match(printed, /Status map:/);
  assert.match(printed, /Field map:/);
  assert.match(printed, /Project map:/);
  assert.match(printed, /mobile/);
});

test("import dry-run prints passthrough project-map wording", async () => {
  const harness = await getHarness();
  const captured = await captureLogs(() =>
    harness.runCommand({
      command: "linear sync",
      options: { team: "ENG", "dry-run": true, "project-map": true },
      global: { json: false },
      pmRoot: "/this-tracker-does-not-exist",
    }),
  );
  assert.match(captured.errors.join("\n"), /passthrough \(tag = Linear project name\)/);
});

test("atomic SDK loader errors and interrupted journals stay typed", async () => {
  await assert.rejects(
    () =>
      importLinearAtomic("/unused-sdk-missing", "ENG", [preparedEntry("ENG-1", "One")], {
        loadSdk: async () => ({}),
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.exitCode, EXIT_CODE.USAGE);
      assert.match(err.message, /does not export commitItemMutations as a function/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      importLinearAtomic("/unused-sdk-throw", "ENG", [preparedEntry("ENG-1", "One")], {
        loadSdk: async () => {
          throw new Error("module not found");
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /SDK could not be imported: module not found/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      importLinearAtomic("/unused-sdk-string", "ENG", [preparedEntry("ENG-1", "One")], {
        loadSdk: async () => {
          throw "bare string";
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /SDK could not be imported: bare string/);
      return true;
    },
  );

  const interrupted = new Error("operator killed the process");
  interrupted.name = "WorkspaceTransactionInterruptedError";
  await assert.rejects(
    () =>
      importLinearAtomic("/unused-interrupted", "ENG", [preparedEntry("ENG-1", "One")], {
        commitItemMutations: async () => {
          throw interrupted;
        },
        normalizeItemId: fakeNormalize,
        readSettings: async () => ({ id_prefix: "test-" }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /Atomic Linear import was interrupted/);
      assert.match(err.message, /durable journal is resumable/);
      return true;
    },
  );

  const recovered = await importLinearAtomic(
    "/unused-recovered",
    "ENG",
    [preparedEntry("ENG-1", "One")],
    {
      commitItemMutations: async () => ({
        transactionId: "tx-recovered",
        status: "committed",
        recovered: true,
        results: {},
      }),
      normalizeItemId: fakeNormalize,
      readSettings: async () => ({ id_prefix: "test-" }),
    },
  );
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.imported, 0);
  assert.equal(recovered.updated, 0);
  assert.equal(recovered.recoveredItems, 1);
});

test("syncLinearIssues requires a key, skips cycle backstops, and recovers atomically", async () => {
  await withEnv({ LINEAR_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => syncLinearIssues({ team: "ENG", limit: 1 }, "/unused-no-key"),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.equal(err.exitCode, EXIT_CODE.USAGE);
        assert.match(err.message, /LINEAR_API_KEY environment variable is not set/);
        return true;
      },
    );
  });

  const skipped = await captureLogs(() =>
    syncLinearIssues(
      { team: "ENG", limit: 10, atomic: true, cycleFilter: "Sprint" },
      "/unused-cycle-skip",
      {
        fetchIssues: async () => [
          makeIssue("ENG-1", "No cycle", { cycleName: null }),
          makeIssue("ENG-2", "Other", { cycleName: "Q3" }),
          makeIssue("ENG-3", "Hit", { cycleName: "Sprint 7" }),
        ],
        readItems: () => [],
        commitAtomic: async () => ({
          transactionId: "tx-cycle",
          recovered: false,
          imported: 1,
          updated: 0,
          itemIds: new Map([["ENG-3", "test-eng-3"]]),
        }),
      },
    ),
  );
  assert.equal(skipped.value.skipped, 2);
  assert.equal(skipped.value.created, 1);
  assert.match(skipped.errors.join("\n"), /Atomically imported 1 new/);

  const recovered = await captureLogs(() =>
    syncLinearIssues(
      { team: "ENG", limit: 10, atomic: true },
      "/unused-recovered-sync",
      {
        fetchIssues: async () => [makeIssue("ENG-1", "One")],
        readItems: () => [],
        commitAtomic: async () => ({
          transactionId: "tx-sync-recovered",
          recovered: true,
          imported: 0,
          updated: 0,
          itemIds: new Map(),
        }),
      },
    ),
  );
  assert.equal(recovered.value.recovered, true);
  assert.equal(recovered.value.recoveredItems, undefined);
  assert.match(recovered.errors.join("\n"), /Atomic import recovered transaction tx-sync-recovered/);

  const recoveredWithCount = await captureLogs(() =>
    syncLinearIssues(
      { team: "ENG", limit: 10, atomic: true },
      "/unused-recovered-count",
      {
        fetchIssues: async () => [makeIssue("ENG-1", "One")],
        readItems: () => [],
        commitAtomic: async () => ({
          transactionId: "tx-count",
          recovered: true,
          imported: 0,
          updated: 0,
          recoveredItems: 4,
          itemIds: new Map(),
        }),
      },
    ),
  );
  assert.equal(recoveredWithCount.value.recoveredItems, 4);
});

test("non-atomic sync creates, updates, and skips through the real pm CLI", async () => {
  const root = freshTracker();
  try {
    const created = await captureLogs(() =>
      syncLinearIssues(
        { team: "ENG", limit: 10, stateFilter: "progress", cycleFilter: "q3" },
        root,
        {
          fetchIssues: async () => [
            makeIssue("ENG-1", "New work", {
              body: "Details",
              dueDate: "2026-08-01",
              labels: ["bug"],
              assigneeEmail: "dev@acme.com",
              cycleName: "Q3",
            }),
            makeIssue("ENG-2", "Skip state", { stateName: "Todo", stateType: "unstarted" }),
            makeIssue("ENG-3", "Skip cycle", { cycleName: null }),
          ],
        },
      ),
    );
    assert.equal(created.value.created, 1);
    assert.equal(created.value.skipped, 2);
    assert.equal(listItems(root).length, 1);

    const updated = await captureLogs(() =>
      syncLinearIssues(
        {
          team: "ENG",
          limit: 10,
          stateFilter: "progress",
          cycleFilter: "q3",
        },
        root,
        {
          fetchIssues: async () => [
            makeIssue("ENG-1", "Renamed", {
              body: "Updated body",
              dueDate: "2026-09-01",
              labels: ["bug", "frontend"],
              assigneeEmail: "dev@acme.com",
              cycleName: "Q3",
            }),
            makeIssue("ENG-4", "State miss", { stateName: "Todo", stateType: "unstarted" }),
            makeIssue("ENG-5", "Cycle miss", { cycleName: "Sprint 1" }),
          ],
        },
      ),
    );
    assert.equal(updated.value.updated, 1);
    assert.equal(updated.value.skipped, 2);
    assert.equal(listItems(root)[0]?.title.includes("Renamed"), true);

    const failedUpdate = await captureLogs(() =>
      syncLinearIssues(
        { team: "ENG", limit: 1 },
        root,
        {
          fetchIssues: async () => [makeIssue("ENG-9", "Missing target")],
          readItems: () => [
            {
              id: "does-not-exist",
              description: buildProvenance({ id: "uuid-eng-9", identifier: "ENG-9" }),
            },
          ],
        },
      ),
    );
    assert.equal(failedUpdate.value.skipped, 1);
    assert.match(failedUpdate.errors.join("\n"), /Failed to update item for ENG-9/);

    const failedCreate = await captureLogs(() =>
      syncLinearIssues(
        { team: "ENG", limit: 1 },
        "/this-tracker-does-not-exist",
        {
          fetchIssues: async () => [makeIssue("ENG-10", "Cannot create")],
          readItems: () => [],
        },
      ),
    );
    assert.equal(failedCreate.value.skipped, 1);
    assert.match(failedCreate.errors.join("\n"), /Failed to create item for ENG-10/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear sync command covers missing team, atomic recovery, and unexpected failures", async () => {
  const harness = await getHarness();
  await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
    await assert.rejects(
      () => harness.runCommand({ command: "linear sync", options: {} }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.equal(err.exitCode, EXIT_CODE.USAGE);
        assert.match(err.message, /Missing Linear team/);
        return true;
      },
    );
  });

  await assert.rejects(
    () =>
      harness.runCommand({
        command: "linear sync",
        options: { team: "ENG", [PREFLIGHT_ERROR_OPTION]: "preflight blocked the write" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /preflight blocked the write/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      harness.runCommand({
        command: "linear sync",
        options: { team: "ENG", [PREFLIGHT_ERROR_OPTION]: "" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /LINEAR_API_KEY environment variable is not set/);
      return true;
    },
  );

  const root = freshTracker();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test_key", LINEAR_DEFAULT_TEAM: "eng" }, async () => {
      const live = await withHttps(
        () => issuesPage([issueNode("ENG-1", "From command")]),
        async () =>
          captureLogs(() =>
            harness.runCommand({
              command: "linear sync",
              options: { limit: 5 },
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      const body = payload(live.value);
      assert.equal(body.created, 1);
      assert.equal(body.success, true);
      assert.match(live.errors.join("\n"), /Using LINEAR_DEFAULT_TEAM=ENG/);
      assert.match(live.errors.join("\n"), /Synced 1 issue/);

      const skipped = await withHttps(
        () =>
          issuesPage([
            issueNode("ENG-2", "Wrong state", { stateName: "Todo", stateType: "unstarted" }),
          ]),
        async () =>
          captureLogs(() =>
            harness.runCommand({
              command: "linear sync",
              options: { team: "ENG", state: "progress" },
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      assert.equal(payload(skipped.value).skipped, 1);
      assert.match(skipped.errors.join("\n"), /1 skipped/);

      const atomic = await withHttps(
        () => issuesPage([issueNode("ENG-3", "Atomic")]),
        async () =>
          captureLogs(() =>
            harness.runCommand({
              command: "linear sync",
              options: { team: "ENG", atomic: true },
              pmRoot: root,
            }),
          ),
      );
      const atomicBody = payload(atomic.value);
      assert.equal(atomicBody.atomic, true);
      assert.equal(typeof atomicBody.transactionId, "string");

      await withHttps(() => graphqlOk({ issues: { nodes: [{ identifier: "bad" }] } }), async () => {
        await assert.rejects(
          () =>
            harness.runCommand({
              command: "linear sync",
              options: { team: "ENG" },
              pmRoot: root,
            }),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.match(err.message, /Linear sync failed:/);
            return true;
          },
        );
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate reports readiness offline and through a live probe", async () => {
  const harness = await getHarness();
  const missing = await withEnv(
    { LINEAR_API_KEY: undefined, LINEAR_DEFAULT_TEAM: undefined },
    async () =>
      captureLogs(() =>
        harness.runCommand({
          command: "linear validate",
          options: {},
          global: { json: false },
        }),
      ),
  );
  const missingBody = payload(missing.value);
  assert.equal(missingBody.apiKeyPresent, false);
  assert.equal(missingBody.readyForWrites, false);
  assert.match(missing.errors.join("\n"), /MISSING/);
  assert.match(missing.errors.join("\n"), /Ready for writes:\s+no/);

  const present = await withEnv(
    { LINEAR_API_KEY: "lin_test_key", LINEAR_DEFAULT_TEAM: "ENG" },
    async () =>
      payload(
        await harness.runCommand({
          command: "linear validate",
          options: {},
        }),
      ),
  );
  assert.equal(present.apiKeyPresent, true);
  assert.equal(present.defaultTeam, "ENG");
  assert.equal(present.networkChecked, false);

  await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
    const ok = await withHttps(() => graphqlOk({ viewer: { id: "user-1" } }), async () =>
      captureLogs(() =>
        harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
          global: { json: false },
        }),
      ),
    );
    assert.equal(payload(ok.value).networkOk, true);
    assert.match(ok.errors.join("\n"), /API reachability:\s+ok/);

    const rejected = await withHttps(
      () => ({ status: 200, body: JSON.stringify({ errors: [{ message: "bad key" }] }) }),
      async () =>
        payload(
          await harness.runCommand({
            command: "linear validate",
            options: { "check-network": true },
          }),
        ),
    );
    assert.equal(rejected.networkOk, false);
    assert.match(String(rejected.networkError), /rejected the credentials: bad key/);

    const noViewer = await withHttps(() => graphqlOk({ viewer: {} }), async () =>
      payload(
        await harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
        }),
      ),
    );
    assert.match(String(noViewer.networkError), /returned no viewer/);

    const unreachable = await withHttps(() => ({ error: new Error("ECONNRESET") }), async () =>
      captureLogs(() =>
        harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
          global: { json: false },
        }),
      ),
    );
    assert.equal(payload(unreachable.value).networkOk, false);
    assert.match(unreachable.errors.join("\n"), /FAILED/);
  });
});

test("preflight override injects a sentinel only when Linear is actually reached", async () => {
  const harness = await getHarness();
  const skipped = await harness.runPreflightOverride(
    preflightContext("linear sync", { "dry-run": true }),
  );
  assert.deepEqual(skipped.context.options, { "dry-run": true });

  await withEnv({ LINEAR_API_KEY: undefined }, async () => {
    const missing = await harness.runPreflightOverride(preflightContext("linear sync", {}));
    assert.equal(typeof missing.context.options?.[PREFLIGHT_ERROR_OPTION], "string");
  });

  await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
    const offline = await harness.runPreflightOverride(
      preflightContext("linear sync", { "skip-preflight-network": true }),
    );
    assert.equal(offline.context.options?.[PREFLIGHT_ERROR_OPTION], undefined);

    const legacy = await harness.runPreflightOverride(
      preflightContext("linear export", { push: true, "no-preflight-network": true }),
    );
    assert.equal(legacy.context.options?.[PREFLIGHT_ERROR_OPTION], undefined);

    const fromEnv = await withEnv({ LINEAR_PREFLIGHT_NO_NETWORK: "1" }, async () =>
      harness.runPreflightOverride(preflightContext("linear import", {})),
    );
    assert.equal(fromEnv.context.options?.[PREFLIGHT_ERROR_OPTION], undefined);

    const live = await withHttps(() => graphqlOk({ viewer: { id: "user-1" } }), async () =>
      harness.runPreflightOverride(preflightContext("linear sync", {})),
    );
    assert.equal(live.context.options?.[PREFLIGHT_ERROR_OPTION], undefined);
  });
});

test("linear importer and linear-sync importer share dry-run, env, and write paths", async () => {
  const harness = await getHarness();
  await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () => {
    await assert.rejects(
      () => harness.runImporter({ importer: "linear", options: {} }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /Missing Linear team/);
        return true;
      },
    );
    await assert.rejects(
      () => harness.runImporter({ importer: "linear-sync", options: {} }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /requires a 'team' option/);
        return true;
      },
    );
  });

  const dry = payload(
    await harness.runImporter({
      importer: "linear",
      options: { team: "ENG", "dry-run": true },
    }),
  );
  assert.equal(dry.dryRun, true);
  assert.equal(dry.imported, 0);

  const root = freshTracker();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test_key", LINEAR_DEFAULT_TEAM: "eng" }, async () => {
      const imported = await withHttps(
        () => issuesPage([issueNode("ENG-20", "Importer")]),
        async () =>
          captureLogs(() =>
            harness.runImporter({
              importer: "linear",
              options: {},
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      const importedBody = payload(imported.value);
      assert.equal(importedBody.created, 1);
      assert.match(imported.errors.join("\n"), /Imported 1 issue/);

      const skipped = await withHttps(
        () =>
          issuesPage([
            issueNode("ENG-21", "Skip me", { stateName: "Todo", stateType: "unstarted" }),
          ]),
        async () =>
          captureLogs(() =>
            harness.runImporter({
              importer: "linear",
              options: { team: "ENG", state: "progress" },
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      assert.equal(payload(skipped.value).skipped, 1);
      assert.match(skipped.errors.join("\n"), /skipped/);

      const atomic = await withHttps(
        () => issuesPage([issueNode("ENG-22", "Atomic import")]),
        async () =>
          harness.runImporter({
            importer: "linear",
            options: { team: "ENG", atomic: true },
            pmRoot: root,
          }),
      );
      assert.equal(payload(atomic).atomic, true);

      await withHttps(() => graphqlOk({ issues: { nodes: [{ identifier: "bad" }] } }), async () => {
        await assert.rejects(
          () =>
            harness.runImporter({
              importer: "linear",
              options: { team: "ENG" },
              pmRoot: root,
            }),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.match(err.message, /Linear import failed:/);
            return true;
          },
        );
      });

      const syncEnv = await withHttps(
        () => issuesPage([issueNode("ENG-23", "Legacy")]),
        async () =>
          captureLogs(() =>
            harness.runImporter({
              importer: "linear-sync",
              options: {},
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      assert.equal(payload(syncEnv.value).created, 1);
      assert.match(syncEnv.errors.join("\n"), /Using LINEAR_DEFAULT_TEAM=ENG/);
      assert.match(syncEnv.errors.join("\n"), /Synced 1 issues/);

      const syncAtomic = await withHttps(
        () => issuesPage([issueNode("ENG-24", "Legacy atomic")]),
        async () =>
          harness.runImporter({
            importer: "linear-sync",
            options: { team: "ENG", atomic: true },
            pmRoot: root,
          }),
      );
      const syncAtomicBody = payload(syncAtomic);
      assert.equal(syncAtomicBody.atomic, true);
      assert.equal(typeof syncAtomicBody.transactionId, "string");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export previews, dry-runs, and pushes create plus update", async () => {
  const harness = await getHarness();
  const root = freshTracker();
  try {
    createPmItem(root, ["--title", "Fresh issue", "--status", "open", "--priority", "1"]);
    createPmItem(root, [
      "--title",
      "Linked issue",
      "--status",
      "in_progress",
      "--description",
      buildProvenance({ id: "lin-linked", identifier: "ENG-40" }),
      "--tags",
      "bug,estimate:5,cycle:Q3",
      "--deadline",
      "2026-08-01T00:00:00.000Z",
    ]);
    createPmItem(root, [
      "--title",
      "Numbered cycle",
      "--status",
      "open",
      "--tags",
      "cycle:42",
    ]);
    createPmItem(root, [
      "--title",
      "Unknown cycle",
      "--status",
      "open",
      "--tags",
      "cycle:Ghost",
    ]);

    const preview = await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () =>
      captureLogs(() =>
        harness.runExporter({
          exporter: "linear",
          options: {},
          global: { json: false },
          pmRoot: root,
        }),
      ),
    );
    const previewBody = payload(preview.value);
    assert.equal(previewBody.pushed, false);
    assert.equal(previewBody.dryRun, false);
    assert.match(preview.errors.join("\n"), /No team resolved for create payloads/);
    assert.ok(preview.logs.some((line) => line.includes("Fresh issue")));

    const previewJson = payload(
      await harness.runExporter({
        exporter: "linear",
        options: { team: "ENG" },
        pmRoot: root,
      }),
    );
    assert.equal(previewJson.pushed, false);
    assert.ok(Array.isArray(previewJson.payloads));

    const dry = await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () =>
      captureLogs(() =>
        harness.runExporter({
          exporter: "linear",
          options: { "dry-run": true, "status-map": "In Progress=in_progress" },
          global: { json: false },
          pmRoot: root,
        }),
      ),
    );
    assert.equal(payload(dry.value).dryRun, true);
    assert.match(dry.errors.join("\n"), /Would push/);
    assert.match(dry.errors.join("\n"), /No team resolved for create payloads/);
    assert.match(dry.errors.join("\n"), /issueCreate|issueUpdate/);

    const dryJson = payload(
      await harness.runExporter({
        exporter: "linear",
        options: { team: "ENG", "dry-run": true, push: true },
        pmRoot: root,
      }),
    );
    assert.equal(dryJson.pushed, false);
    assert.equal(dryJson.team, "ENG");

    await withEnv({ LINEAR_API_KEY: undefined }, async () => {
      await assert.rejects(
        () =>
          harness.runExporter({
            exporter: "linear",
            options: { team: "ENG", push: true },
            pmRoot: root,
          }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /--push requires LINEAR_API_KEY/);
          return true;
        },
      );
    });

    await withEnv({ LINEAR_API_KEY: "lin_test_key", LINEAR_DEFAULT_TEAM: undefined }, async () => {
      await assert.rejects(
        () =>
          harness.runExporter({
            exporter: "linear",
            options: { push: true },
            pmRoot: root,
          }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match(err.message, /--push requires --team/);
          return true;
        },
      );
    });

    await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
      await withHttps(
        () => ({ status: 200, body: JSON.stringify({ errors: [{ message: "no team" }] }) }),
        async () => {
          await assert.rejects(
            () =>
              harness.runExporter({
                exporter: "linear",
                options: { team: "ENG", push: true },
                pmRoot: root,
              }),
            (err: unknown) => {
              assert.ok(err instanceof CommandError);
              assert.match(err.message, /Linear API error resolving team ENG: no team/);
              return true;
            },
          );
        },
      );

      await withHttps(() => graphqlOk({ teams: { nodes: [] } }), async () => {
        await assert.rejects(
          () =>
            harness.runExporter({
              exporter: "linear",
              options: { team: "ENG", push: true },
              pmRoot: root,
            }),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.equal(err.exitCode, EXIT_CODE.NOT_FOUND);
            assert.match(err.message, /Linear team "ENG" not found/);
            return true;
          },
        );
      });

      let creates = 0;
      let updates = 0;
      const pushed = await withEnv({ LINEAR_DEFAULT_TEAM: "eng" }, async () =>
        withHttps((payload) => {
          if (payload.query.includes("teams(")) {
            return graphqlOk({
              teams: {
                nodes: [
                  {
                    id: "team-1",
                    states: {
                      nodes: [
                        { id: "state-open", name: "Backlog" },
                        { id: "state-progress", name: "In Progress" },
                        { name: "No id" },
                        { id: "state-orphan" },
                      ],
                    },
                    labels: {
                      nodes: [
                        { id: "label-bug", name: "bug" },
                        { id: "label-dup", name: "bug" },
                        { name: "nameless" },
                        { id: "label-orphan" },
                      ],
                    },
                    cycles: {
                      nodes: [
                        { id: "cycle-q3", name: "Q3", number: 3 },
                        { id: "cycle-42", name: null, number: 42 },
                        { name: "ghost" },
                        { id: "cycle-sprint", name: "Sprint 7" },
                      ],
                    },
                  },
                ],
              },
            });
          }
          if (payload.query.includes("issueUpdate")) {
            updates += 1;
            if (updates === 1) {
              return { status: 200, body: JSON.stringify({ errors: [{ message: "update failed" }] }) };
            }
            return graphqlOk({ issueUpdate: { success: true } });
          }
          if (payload.query.includes("issueCreate")) {
            creates += 1;
            if (creates === 1) {
              return { status: 200, body: JSON.stringify({ errors: [{ message: "create failed" }] }) };
            }
            return graphqlOk({ issueCreate: { success: true } });
          }
          return { status: 500, body: "unexpected" };
        }, async () =>
          captureLogs(() =>
            harness.runExporter({
              exporter: "linear",
              options: {
                push: true,
                "status-map": "Backlog=open,In Progress=in_progress",
              },
              global: { json: false },
              pmRoot: root,
            }),
          ),
        ),
      );
      const pushedBody = payload(pushed.value);
      assert.equal(pushedBody.pushed, true);
      assert.ok((pushedBody.skipped as number) >= 1);
      assert.ok((pushedBody.created as number) + (pushedBody.updated as number) >= 1);
      assert.match(pushed.errors.join("\n"), /Using LINEAR_DEFAULT_TEAM=ENG/);
      assert.match(pushed.errors.join("\n"), /Pushed /);
      assert.match(pushed.errors.join("\n"), /Failed to push item/);
      assert.match(pushed.errors.join("\n"), /did not match any cycle/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildImportDryRunPlan defaults omitted maps and mixed project-map pairs", () => {
  const plan = buildImportDryRunPlan({ team: "eng", limit: 10 }, "/no-such-tracker");
  assert.deepEqual(plan.statusMap, {});
  assert.deepEqual(plan.projectMap, { enabled: false, passthrough: false, map: {} });
  assert.equal(plan.existingLinkedItems, 0);
  assert.equal(parseProjectMap("nope,Mobile=mobile,also").map.mobile, "mobile");
});

test("shared receipt helpers cover Error vs non-Error and sparse atomic fields", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("bare"), "bare");
  assert.equal(errorMessage(42), "42");
  assert.deepEqual(atomicReceiptFields({}), {});
  assert.deepEqual(
    atomicReceiptFields({
      atomic: true,
      transactionId: "tx",
      recovered: true,
      recoveredItems: 4,
    }),
    { atomic: true, transactionId: "tx", recovered: true, recoveredItems: 4 },
  );
  assert.deepEqual(atomicReceiptFields({ atomic: false, recovered: false }), {
    recovered: false,
  });
  assert.equal(pushItemLabel({ linearId: "lin", pmId: "pm", title: "T" }), "lin");
  assert.equal(pushItemLabel({ pmId: "pm", title: "T" }), "pm");
  assert.equal(pushItemLabel({ title: "T" }), "T");
  assert.equal(linearPreviewState(undefined), null);
  assert.equal(linearPreviewState("Todo"), "Todo");
  assert.equal(linearPreviewPriority(undefined), 0);
  assert.equal(linearPreviewPriority(2), 2);
  assert.deepEqual(parseFieldMap("garbage,Done=closed"), { done: "closed" });
});

test("throwIfLinearErrors is silent on a clean envelope and names the failed mutation", () => {
  assert.doesNotThrow(() => throwIfLinearErrors({}, "issueUpdate"));
  assert.doesNotThrow(() => throwIfLinearErrors({ errors: [] }, "issueCreate"));
  assert.throws(
    () => throwIfLinearErrors({ errors: [{ message: "nope" }, { message: "again" }] }, "issueUpdate"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Linear issueUpdate failed: nope; again");
      return true;
    },
  );
  assert.throws(
    () => throwIfLinearErrors({ errors: [{ message: "denied" }] }, "issueCreate"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Linear issueCreate failed: denied");
      return true;
    },
  );
});

test("buildExportMutationPlan omits optional fields when they are absent", () => {
  const plan = buildExportMutationPlan(
    { title: "Bare", description: "", alreadyInLinear: false },
    {},
    "ENG",
  );
  const input = plan.variables.input as Record<string, unknown>;
  assert.equal("priority" in input, false);
  assert.equal("labelNames" in input, false);
  assert.equal("dueDate" in input, false);
});

test("remaining mapping helpers cover fallbacks the live suite never hits", () => {
  assert.equal(buildItemPlan(makeIssue("ENG-1", "Med", { priority: 3 }), {}).priority, 3);
  assert.equal(buildItemPlan(makeIssue("ENG-1", "Low", { priority: 4 }), {}).priority, 4);
  assert.equal(buildItemPlan(makeIssue("ENG-1", "None", { priority: 0 }), {}).priority, 3);

  const ignored = parseFieldMap("title=ignore,description=ignore,status=ignore");
  const plan = buildItemPlan(makeIssue("ENG-1", "Hidden", { body: "secret" }), {}, ignored);
  assert.equal(plan.title, "[ENG-1] (untitled)");
  assert.equal(plan.body, "");
  assert.equal(plan.status, "open");

  assert.equal(resolveStatus("unstarted", "In Review", {}), "in_progress");
  assert.equal(resolveStatus("unstarted", "Blocked", {}), "blocked");
  assert.equal(resolveStatus("unstarted", "Done", {}), "closed");
  assert.equal(resolveStatus("unstarted", "completed elsewhere", {}), "closed");
  assert.equal(resolveStatus("unstarted", "Cancelled", {}), "closed");
  assert.equal(resolveStatus("cancelled", "Anything", {}), "closed");

  assert.equal(normalizeDueDate("   "), undefined);
  assert.equal(normalizeDueDate("soon"), undefined);
  assert.equal(parseProvenance("[linear] linear_url=https://x"), undefined);
  assert.deepEqual(parseProvenance("[linear] linear_id=abc"), {
    linear_id: "abc",
    linear_url: "",
  });

  const tied = preparedEntry("ENG-1", "Same");
  assert.match(deriveAtomicTransactionId("ENG", [tied, tied], []), /^linear-import-/);

  const withDeadline = buildAtomicImportMutations(
    "ENG",
    { ...preparedEntry("ENG-9", "Dated"), deadline: "2026-08-01", assignee: "dev@acme.com" },
    "test-",
    fakeNormalize,
  );
  const create = withDeadline.mutations.find((mutation) => mutation.op === "create");
  assert.ok(create && create.op === "create");
  if (create && create.op === "create") {
    assert.equal(create.options.deadline, "2026-08-01");
    assert.equal(create.options.assignee, "dev@acme.com");
  }
});

test("syncLinearIssues logs every live filter and atomic command dry-run skips commit", async () => {
  const empty = await captureLogs(() =>
    syncLinearIssues(
      {
        team: "ENG",
        limit: 1,
        project: "Mobile",
        assignee: "dev@acme.com",
        label: "bug",
        updatedSince: "2026-01-01",
        stateFilter: "progress",
        cycleFilter: "Q3",
      },
      "/unused-scope",
      { fetchIssues: async () => [] },
    ),
  );
  const line = empty.errors.join("\n");
  assert.match(line, /project "Mobile"/);
  assert.match(line, /assignee dev@acme.com/);
  assert.match(line, /label "bug"/);
  assert.match(line, /updated since 2026-01-01/);

  const harness = await getHarness();
  const root = freshTracker();
  try {
    await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
      const dry = await withHttps(
        () => issuesPage([issueNode("ENG-1", "Preview")]),
        async () =>
          captureLogs(() =>
            harness.runCommand({
              command: "linear sync",
              options: { team: "ENG", atomic: true, "dry-run": true },
              pmRoot: root,
            }),
          ),
      );
      const body = payload(dry.value);
      assert.equal(body.atomic, true);
      assert.equal(body.dryRun, true);
      assert.equal(body.transactionId, undefined);
      assert.equal(listItems(root).length, 0);

      const none = await withHttps(
        () => issuesPage([]),
        async () =>
          captureLogs(() =>
            harness.runCommand({
              command: "linear sync",
              options: { team: "ENG" },
              global: { json: false },
              pmRoot: root,
            }),
          ),
      );
      assert.match(none.errors.join("\n"), /Synced 0 issues/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear export push can fail an update and succeed a tagged create", async () => {
  const harness = await getHarness();
  const root = freshTracker();
  try {
    createPmItem(root, [
      "--title",
      "Only linked",
      "--status",
      "open",
      "--description",
      buildProvenance({ id: "lin-only", identifier: "ENG-80" }),
    ]);
    const preview = payload(
      await harness.runExporter({
        exporter: "linear",
        options: { team: "ENG" },
        pmRoot: root,
      }),
    );
    assert.equal(preview.wouldUpdate, 1, JSON.stringify(preview));
    await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
      const queries: string[] = [];
      const failedUpdate = await withHttps((payload) => {
        queries.push(payload.query.slice(0, 80));
        if (payload.query.includes("teams(")) {
          return graphqlOk({
            teams: {
              nodes: [{ id: "team-1", states: { nodes: [] }, labels: { nodes: [] }, cycles: { nodes: [] } }],
            },
          });
        }
        return {
          status: 200,
          body: JSON.stringify({ errors: [{ message: "unique-update-boom" }] }),
        };
      }, async () =>
        captureLogs(() =>
          harness.runExporter({
            exporter: "linear",
            options: { team: "ENG", push: true },
            pmRoot: root,
          }),
        ),
      );
      const failedBody = payload(failedUpdate.value);
      assert.equal(failedBody.skipped, 1, queries.join(" | "));
      assert.equal(failedBody.updated, 0);
      assert.match(
        failedUpdate.errors.join("\n"),
        /Linear issueUpdate failed: unique-update-boom/,
        queries.join(" | "),
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const createRoot = freshTracker();
  try {
    createPmItem(createRoot, [
      "--title",
      "Fresh tagged",
      "--status",
      "open",
      "--tags",
      "bug",
      "--deadline",
      "2026-08-01T00:00:00.000Z",
    ]);
    await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
      const created = await withHttps((payload) => {
        if (payload.query.includes("teams(")) {
          return graphqlOk({
            teams: {
              nodes: [
                {
                  id: "team-1",
                  labels: { nodes: [{ id: "label-bug", name: "bug" }] },
                },
              ],
            },
          });
        }
        if (payload.query.includes("issueCreate")) {
          const input = payload.variables.input as Record<string, unknown>;
          assert.deepEqual(input.labelIds, ["label-bug"]);
          assert.equal(input.dueDate, "2026-08-01");
          return graphqlOk({ issueCreate: { success: true } });
        }
        return { status: 500, body: "unexpected" };
      }, async () =>
        captureLogs(() =>
          harness.runExporter({
            exporter: "linear",
            options: { team: "ENG", push: true },
            global: { json: false },
            pmRoot: createRoot,
          }),
        ),
      );
      const createdBody = payload(created.value);
      assert.equal(createdBody.created, 1);
      assert.equal(createdBody.skipped, 0);
      assert.match(created.errors.join("\n"), /Pushed 1 issue/);
      assert.doesNotMatch(created.errors.join("\n"), /skipped/);
    });
  } finally {
    fs.rmSync(createRoot, { recursive: true, force: true });
  }
});

test("retry-after arrays, reverse-ordered atomic entries, and atomic deadlines are honored", async () => {
  await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
    let calls = 0;
    const recovered = await withHttps(() => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, headers: { "retry-after": ["0"] }, body: "wait" };
      }
      return issuesPage([]);
    }, async () =>
      captureLogs(() =>
        syncLinearIssues({ team: "ENG", limit: 1 }, "/unused-array-retry", {
          readItems: () => [],
        }),
      ),
    );
    assert.equal(recovered.value.synced, 0);
    assert.equal(calls, 2);
  });

  const committed: string[] = [];
  await importLinearAtomic(
    "/unused-order",
    "ENG",
    [preparedEntry("ENG-2", "Second"), preparedEntry("ENG-1", "First")],
    {
      commitItemMutations: async (options) => {
        committed.push(...options.mutations.map((mutation) => mutation.op));
        return {
          transactionId: "tx-order",
          status: "committed",
          recovered: false,
          results: {},
        };
      },
      normalizeItemId: fakeNormalize,
      readSettings: async () => ({ id_prefix: "test-" }),
    },
  );
  assert.ok(committed.length > 0);

  const dated = await captureLogs(() =>
    syncLinearIssues(
      { team: "ENG", limit: 1, atomic: true },
      "/unused-deadline",
      {
        fetchIssues: async () => [makeIssue("ENG-1", "Dated", { dueDate: "2026-08-01" })],
        readItems: () => [],
        commitAtomic: async (_root, _team, entries) => {
          assert.equal(entries[0]?.deadline, "2026-08-01");
          return {
            transactionId: "tx-deadline",
            recovered: false,
            imported: 1,
            updated: 0,
            itemIds: new Map([["ENG-1", "test-eng-1"]]),
          };
        },
      },
    ),
  );
  assert.equal(dated.value.created, 1);
});

test("importer rethrows CommandError and export previews cover both json and human team arms", async () => {
  const harness = await getHarness();
  await withEnv({ LINEAR_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => harness.runImporter({ importer: "linear", options: { team: "ENG" } }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /LINEAR_API_KEY environment variable is not set/);
        return true;
      },
    );
  });

  const root = freshTracker();
  try {
    createPmItem(root, ["--title", "Preview me", "--status", "open"]);
    createPmItem(root, ["--title", "Draft work", "--status", "draft"]);
    const jsonNoTeam = await withEnv({ LINEAR_DEFAULT_TEAM: undefined }, async () =>
      payload(
        await harness.runExporter({
          exporter: "linear",
          options: {},
          pmRoot: root,
        }),
      ),
    );
    assert.equal(jsonNoTeam.team, undefined);
    const previewRows = jsonNoTeam.payloads as Array<{ title: string; targetState: string | null }>;
    assert.equal(
      previewRows.find((row) => row.title === "Draft work")?.targetState,
      null,
    );

    const humanWithTeam = await captureLogs(() =>
      harness.runExporter({
        exporter: "linear",
        options: { team: "ENG" },
        global: { json: false },
        pmRoot: root,
      }),
    );
    assert.equal(payload(humanWithTeam.value).team, "ENG");

    await withEnv({ LINEAR_API_KEY: "lin_test_key" }, async () => {
      const pushed = await withHttps((body) => {
        if (body.query.includes("teams(")) {
          return graphqlOk({ teams: { nodes: [{ id: "team-only" }] } });
        }
        return graphqlOk({ issueCreate: { success: true } });
      }, async () =>
        harness.runExporter({
          exporter: "linear",
          options: { team: "ENG", push: true },
          pmRoot: root,
        }),
      );
      assert.equal(payload(pushed).created, 2);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic import wraps a non-Error commit rejection", async () => {
  await assert.rejects(
    () =>
      importLinearAtomic("/unused-string-throw", "ENG", [preparedEntry("ENG-1", "One")], {
        commitItemMutations: async () => {
          throw "commit exploded";
        },
        normalizeItemId: fakeNormalize,
        readSettings: async () => ({ id_prefix: "test-" }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /commit exploded/);
      return true;
    },
  );
});
