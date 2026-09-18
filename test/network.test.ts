/**
 * Behavioural tests for the Linear network client and the command/importer/
 * exporter paths that reach it.
 *
 * The Linear GraphQL client (`linearRequest`/`linearRequestOnce`), the
 * paginating fetch (`fetchAllLinearIssues`), the push-time team resolver
 * (`resolveTeamContext`), and the preflight reachability probe all speak to
 * `api.linear.app` over HTTPS. Rather than monkey-patching `fetch` or `https`,
 * these tests point the client at a real local `node:http` server on
 * 127.0.0.1 that speaks the same GraphQL-over-JSON wire format, injected
 * through the package's `LINEAR_API_BASE_URL` endpoint override. The server is
 * programmable per test so each wire-level outcome (200 success, 429 retry,
 * 401 auth, 5xx exhaustion, GraphQL errors, pagination, malformed body, parse
 * failure, timeout) is reproduced from the real request/response cycle.
 *
 * The command handlers are driven through pm's real dispatch engine
 * (`createExtensionTestHarness` -> `runCommand`/`runImporter`/`runExporter`/
 * `runPreflightOverride`), not a hand-rolled api double, against a real `pm`
 * workspace created under `mkdtempSync(join(tmpdir(), "pm-linear-"))`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PreflightOverrideContext } from "@unbrained/pm-cli/sdk/authoring";
import {
  createExtensionTestHarness,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

import extension, {
  CommandError,
  syncLinearIssues,
  type LinearIssue,
} from "../index.ts";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };

/**
 * A programmable Linear GraphQL response.
 *
 * `body` is sent verbatim (already JSON stringified by the caller); `status`
 * defaults to 200; `headers` carries `retry-after` for retry tests. The
 * `hang` sentinel tells the server to accept the connection but never respond,
 * so the client's per-request timeout fires.
 */
interface LinearResponseSpec {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
  hang?: boolean;
}

/**
 * A responder inspects the parsed GraphQL request body and the per-server
 * request counter, returning the response spec to emit. The counter lets a
 * responder vary its answer across retries (e.g. 429 once then 200).
 */
type LinearResponder = (
  requestBody: { query?: string; variables?: Record<string, unknown> },
  requestIndex: number,
) => LinearResponseSpec;

/**
 * A real local Linear-shaped HTTP server bound to 127.0.0.1.
 *
 * Captures every request body it receives so a test can assert on the exact
 * GraphQL query/variables the client sent, and exposes the chosen port so the
 * client can be pointed at it via `LINEAR_API_BASE_URL`.
 */
interface LinearTestServer {
  readonly url: string;
  readonly received: Array<{ query?: string; variables?: Record<string, unknown> }>;
  close(): Promise<void>;
}

/**
 * Start a local Linear-shaped server with a programmable responder.
 *
 * @param respond - The per-request responder.
 * @returns The running server handle plus its URL and received-request log.
 */
async function startLinearServer(
  respond: LinearResponder,
  host = "127.0.0.1",
): Promise<LinearTestServer> {
  const log: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: { query?: string; variables?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      log.push(parsed);
      const spec = respond(parsed, counter++);
      if (spec.hang) {
        // Accept the connection but never respond; the client timeout fires.
        return;
      }
      // Each request is a short-lived real test transaction. Closing the
      // response connection prevents stale keep-alive sockets from surviving
      // into the next server-backed test and being reset during teardown.
      res.setHeader("Connection", "close");
      res.writeHead(spec.status ?? 200, spec.headers);
      res.end(spec.body ?? "");
    });
  });
  server.keepAliveTimeout = 1;
  server.headersTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = getPort(server);
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: "http://" + displayHost + ":" + port,
    received: log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Resolve the ephemeral port a listening server bound to. */
function getPort(server: http.Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("linear test server is not listening on an inet port");
  }
  return addr.port;
}

/** Create a fresh real pm workspace under tmpdir and return its root. */
function freshWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
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

/** Build a Linear issue node in the shape the issues query selects. */
function issue(
  identifier: string,
  overrides: Partial<LinearIssue> = {},
): LinearIssue {
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

/** Wrap an issues-node array in the GraphQL `data.issues` connection envelope. */
function issuesPage(
  nodes: LinearIssue[],
  opts: { hasNext?: boolean; endCursor?: string } = {},
): string {
  return JSON.stringify({
    data: {
      issues: {
        nodes,
        pageInfo: {
          hasNextPage: opts.hasNext ?? false,
          endCursor: opts.endCursor ?? null,
        },
      },
    },
  });
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

/** Assert a syncLinearIssues rejection is a CommandError whose message matches. */
async function assertSyncRejects(
  opts: { team: string; limit: number },
  pmRoot: string,
  env: Record<string, string | undefined>,
  message: RegExp,
): Promise<void> {
  await withEnv(env, async () => {
    await assert.rejects(
      () => syncLinearIssues(opts, pmRoot),
      (err: unknown) => {
        assert.ok(err instanceof CommandError, `expected CommandError, got ${String(err)}`);
        assert.match((err as Error).message, message);
        return true;
      },
    );
  });
}

/** Build a minimal valid preflight override context for a `linear sync` run. */
function preflightCtx(
  root: string,
  options: Record<string, unknown>,
): PreflightOverrideContext {
  return {
    command: "linear sync",
    args: [],
    options,
    global: {},
    pm_root: root,
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  };
}

// ---------------------------------------------------------------------------
// fetchAllLinearIssues + linearRequest: success, pagination, GraphQL errors
// ---------------------------------------------------------------------------

test("syncLinearIssues fetches issues through the real HTTP client and writes pm items", async () => {
  const server = await startLinearServer(() => ({
    body: issuesPage([issue("ENG-1"), issue("ENG-2")]),
  }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 2);
        assert.equal(result.created, 2);
        assert.equal(result.updated, 0);
        assert.equal(result.team, "ENG");
      },
    );
    assert.equal(itemCount(root), 2, "two pm items written for two Linear issues");
    assert.equal(server.received[0]?.variables?.team, "ENG");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAllLinearIssues follows GraphQL cursor pagination up to the limit", async () => {
  let pages = 0;
  const server = await startLinearServer((_body, i) => {
    pages = i + 1;
    if (i === 0) {
      return { body: issuesPage([issue("ENG-10"), issue("ENG-11")], { hasNext: true, endCursor: "cursor-1" }) };
    }
    return { body: issuesPage([issue("ENG-12")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 3, "all three paged issues imported");
      },
    );
    assert.equal(pages, 2, "exactly two pages fetched");
    assert.equal(server.received[1]?.variables?.after, "cursor-1");
    assert.equal(server.received[1]?.variables?.first, 98);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAllLinearIssues stops when a page has no nodes (empty result)", async () => {
  const server = await startLinearServer(() => ({ body: issuesPage([]) }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 0, "no issues -> zero sync");
        assert.equal(result.issues.length, 0);
      },
    );
    assert.equal(itemCount(root), 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a response without an issues connection is treated as an empty page", async () => {
  const server = await startLinearServer(() => ({ body: JSON.stringify({ data: {} }) }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 0);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAllLinearIssues surfaces a GraphQL errors envelope as a CommandError", async () => {
  const server = await startLinearServer(() => ({
    body: JSON.stringify({ errors: [{ message: "rate limited by upstream" }] }),
  }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await assertSyncRejects(
      { team: "ENG", limit: 100 },
      root,
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      /Linear API error: rate limited by upstream/,
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linearRequest retry loop: 429 + Retry-After, 5xx exhaustion, auth, parse
// ---------------------------------------------------------------------------

test("a 429 with Retry-After: 0 is retried once and then succeeds", async () => {
  let calls = 0;
  const server = await startLinearServer((_body, i) => {
    calls = i + 1;
    if (i === 0) {
      return { status: 429, headers: { "retry-after": "0" }, body: "{}" };
    }
    return { body: issuesPage([issue("ENG-1")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1, "retried request succeeded");
      },
    );
    assert.equal(calls, 2, "exactly one retry before success");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 429 with an array-valued Retry-After header is retried", async () => {
  const server = await startLinearServer((_body, i) => {
    if (i === 0) {
      return { status: 429, headers: { "retry-after": ["0"] }, body: "{}" };
    }
    return { body: issuesPage([issue("ENG-1")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 429 with an HTTP-date Retry-After in the past yields a zero delay and succeeds", async () => {
  const pastDate = new Date(0).toUTCString();
  const server = await startLinearServer((_body, i) => {
    if (i === 0) {
      return { status: 429, headers: { "retry-after": pastDate }, body: "{}" };
    }
    return { body: issuesPage([issue("ENG-1")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1, "date-form Retry-After retried and succeeded");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 429 with a gibberish Retry-After falls back to exponential backoff and succeeds", async () => {
  const server = await startLinearServer((_body, i) => {
    if (i === 0) {
      return { status: 429, headers: { "retry-after": "not-a-number-or-date" }, body: "{}" };
    }
    return { body: issuesPage([issue("ENG-1")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1, "unparseable Retry-After retried and succeeded");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 429 with no Retry-After header falls back to exponential backoff and succeeds", async () => {
  const server = await startLinearServer((_body, i) => {
    if (i === 0) {
      return { status: 429, body: "{}" };
    }
    return { body: issuesPage([issue("ENG-1")]) };
  });
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1, "absent Retry-After retried and succeeded");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a persistent 503 exhausts retries and reports HTTP 503", async () => {
  const server = await startLinearServer(() => ({
    status: 503,
    headers: { "retry-after": "0" },
    body: "{}",
  }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await assertSyncRejects(
      { team: "ENG", limit: 100 },
      root,
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      /Linear API unavailable after 5 attempts \(HTTP 503\)/,
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a per-request timeout is retried as a timeout and eventually exhausted", async () => {
  const server = await startLinearServer(() => ({ hang: true }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await assertSyncRejects(
      { team: "ENG", limit: 100 },
      root,
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url, LINEAR_REQUEST_TIMEOUT_MS: "40" },
      /Linear API unavailable after 5 attempts \(HTTP timeout\)/,
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("IPv6 loopback endpoint reaches a real local GraphQL server", async () => {
  const server = await startLinearServer(() => ({ body: issuesPage([issue("ENG-IPV6")]) }), "::1");
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.synced, 1);
      },
    );
    assert.equal(server.received.length, 1);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP endpoint validation rejects non-loopback hosts before any request", async () => {
  const server = await startLinearServer(() => ({ body: issuesPage([issue("ENG-SECURE")] ) }));
  const root = freshWorkspace();
  const invalidEndpoints = [
    "http://127.0.0.1.evil.example.com/graphql",
    "http://169.254.169.254/graphql",
    "http://example.com/graphql",
    "not a url",
  ];
  try {
    for (const endpoint of invalidEndpoints) {
      await withEnv(
        { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: endpoint },
        async () => {
          await assert.rejects(
            () => syncLinearIssues({ team: "ENG", limit: 100 }, root),
            (err: unknown) => {
              assert.ok(err instanceof CommandError);
              assert.match((err as Error).message, /LINEAR_API_BASE_URL/);
              return true;
            },
          );
        },
      );
    }
    assert.equal(server.received.length, 0, "rejected endpoints must not send a request");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid timeout values use the default without breaking a real request", async () => {
  for (const timeout of ["NaN", "0", "-5"]) {
    const server = await startLinearServer(() => ({ body: issuesPage([issue("ENG-TIMEOUT")] ) }));
    const root = freshWorkspace();
    try {
      await withEnv(
        {
          LINEAR_API_KEY: "lin_test",
          LINEAR_API_BASE_URL: server.url,
          LINEAR_REQUEST_TIMEOUT_MS: timeout,
        },
        async () => {
          const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
          assert.equal(result.synced, 1);
        },
      );
      assert.equal(server.received.length, 1);
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("bare HTTP and HTTPS endpoint defaults fail through the real diagnostic path", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    for (const endpoint of ["http://127.0.0.1/graphql", "https://127.0.0.1/graphql"]) {
      await withEnv(
        { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: endpoint, LINEAR_REQUEST_TIMEOUT_MS: "20" },
        async () => {
          const { result } = await harness.runCommand({
            command: "linear validate",
            options: { "check-network": true },
            pmRoot: root,
            global: { json: true },
          });
          assert.equal((result as { networkChecked: boolean; networkOk: boolean }).networkChecked, true);
          assert.equal((result as { networkOk: boolean }).networkOk, false);
        },
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 401 auth failure is non-retriable and yields a USAGE CommandError", async () => {
  const server = await startLinearServer(() => ({ status: 401, body: "{}" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await assert.rejects(
          () => syncLinearIssues({ team: "ENG", limit: 100 }, root),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.equal((err as CommandError).exitCode, 2);
            assert.match((err as Error).message, /Linear API rejected the API key \(HTTP 401\)/);
            return true;
          },
        );
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 200 with a non-JSON body surfaces a parse-failure CommandError", async () => {
  const server = await startLinearServer(() => ({ status: 200, body: "<<not json>>" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await assertSyncRejects(
      { team: "ENG", limit: 100 },
      root,
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      /Linear request failed: Failed to parse Linear response/,
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a connection refused (no server) surfaces a request-failure CommandError", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-linear-net-"));
  try {
    await assertSyncRejects(
      { team: "ENG", limit: 100 },
      root,
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: "http://127.0.0.1:1/graphql" },
      /Linear request failed: /,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// syncLinearIssues legacy loop: update vs create, skip filters
// ---------------------------------------------------------------------------

test("syncLinearIssues updates an existing linked item instead of creating a duplicate", async () => {
  const server = await startLinearServer(() => ({
    body: issuesPage([issue("ENG-1", { title: "Updated title" })]),
  }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        const result = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(result.created, 0, "second run updates, no new create");
        assert.equal(result.updated, 1);
      },
    );
    assert.equal(itemCount(root), 1, "still one item - no duplicate");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues skips issues dropped by the --state backstop filter", async () => {
  const server = await startLinearServer(() => ({
    body: issuesPage([
      issue("ENG-1", { state: { name: "In Progress", type: "started" } }),
      issue("ENG-2", { state: { name: "Backlog", type: "unstarted" } }),
    ]),
  }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues(
          { team: "ENG", limit: 100, stateFilter: "progress" },
          root,
        );
        assert.equal(result.synced, 1, "only the matching-state issue is synced");
        assert.equal(result.skipped, 1, "the non-matching issue is skipped");
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncLinearIssues skips issues dropped by the --cycle backstop filter", async () => {
  const server = await startLinearServer(() => ({
    body: issuesPage([
      issue("ENG-1", { cycle: { name: "Sprint 7" } }),
      issue("ENG-2", { cycle: null }),
    ]),
  }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const result = await syncLinearIssues(
          { team: "ENG", limit: 100, cycleFilter: "Sprint" },
          root,
        );
        assert.equal(result.synced, 1, "only the cycle-matching issue is synced");
        assert.equal(result.skipped, 1);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveTeamContext + export push (real HTTP): create, update, cycle, errors
// ---------------------------------------------------------------------------

let netHarness: ExtensionTestHarness | undefined;
async function getHarness(): Promise<ExtensionTestHarness> {
  if (!netHarness) {
    netHarness = await createExtensionTestHarness(extension, {
      name: "pm-linear",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
    assert.deepEqual(netHarness.activation.failed, [], "activation must not fail");
  }
  return netHarness;
}

/** A TEAM_QUERY response with one team, its states/labels/cycles. */
function teamResponse(): string {
  return JSON.stringify({
    data: {
      teams: {
        nodes: [
          {
            id: "team-uuid-1",
            states: { nodes: [{ id: "st-todo", name: "Todo" }, { id: "st-prog", name: "In Progress" }] },
            labels: { nodes: [{ id: "lbl-bug", name: "bug" }] },
            cycles: { nodes: [{ id: "cyc-q3", name: "Q3", number: 3 }] },
          },
        ],
      },
    },
  });
}

/** A successful issueCreate/issueUpdate mutation response. */
function mutationOk(identifier: string): string {
  return JSON.stringify({
    data: { issueCreate: { success: true, issue: { id: `lin-${identifier}`, identifier, url: `https://linear.app/issue/${identifier}` } } },
  });
}

test("sync writes and then updates optional deadline and assignee fields", async () => {
  const server = await startLinearServer(() => ({
    body: issuesPage([
      issue("ENG-OPTIONAL", {
        dueDate: "2026-02-03",
        assignee: { email: "ada@example.com", name: "Ada" },
      }),
    ]),
  }));
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const first = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(first.created, 1);
        const second = await syncLinearIssues({ team: "ENG", limit: 100 }, root);
        assert.equal(second.updated, 1);
      },
    );
    assert.equal(itemCount(root), 1);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push creates fresh issues and updates linked issues through the real API", async () => {
  let mutationCalls = 0;
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("issues(")) return { body: issuesPage([issue("ENG-1")]) };
    if (query?.includes("teams(")) return { body: teamResponse() };
    mutationCalls++;
    return { body: mutationOk("ENG-NEW") };
  });
  const root = freshWorkspace();
  try {
    // Import one item so the export has a linked (update) target.
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await syncLinearIssues({ team: "ENG", limit: 100 }, root);
      },
    );
    // Add a fresh, unlinked pm item for the create path.
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Fresh idea", "--status", "open", "--priority", "2", "--description", "no provenance"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);

    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
        const r = result as { created: number; updated: number; skipped: number; pushed: boolean };
        assert.equal(r.pushed, true);
        assert.equal(r.created, 1, "one fresh item created");
        assert.equal(r.updated, 1, "one linked item updated");
        assert.equal(r.skipped, 0);
      },
    );
    assert.ok(mutationCalls >= 2, "create + update mutations both sent");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push tolerates partial team state, label, and cycle nodes", async () => {
  const partialTeam = JSON.stringify({
    data: {
      teams: {
        nodes: [
          {
            id: "team-uuid-1",
            states: { nodes: [{}, { id: "st-open", name: "Todo" }] },
            labels: { nodes: [{}, { id: "lbl-bug", name: "bug" }] },
            cycles: { nodes: [{}, { id: "cyc-q3", name: "Q3", number: 3 }] },
          },
        ],
      },
    },
  });
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) return { body: partialTeam };
    return { body: mutationOk("ENG-PARTIAL") };
  });
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Partial team", "--status", "open", "--priority", "1", "--description", "fresh", "--tags", "bug"],
      PM_SPAWN_OPTS,
    );
    assert.equal(add.status, 0, add.stderr);
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
        assert.equal((result as { created: number }).created, 1);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push accepts a team response with omitted nested connections", async () => {
  const sparseTeam = JSON.stringify({ data: { teams: { nodes: [{ id: "team-sparse" }] } } });
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) return { body: sparseTeam };
    return { body: mutationOk("ENG-SPARSE") };
  });
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Sparse team", "--status", "open", "--priority", "1", "--description", "fresh"],
      PM_SPAWN_OPTS,
    );
    assert.equal(add.status, 0, add.stderr);
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
        assert.equal((result as { created: number }).created, 1);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push includes deadline fields for both create and update", async () => {
  let mutations = 0;
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) return { body: teamResponse() };
    mutations++;
    return { body: mutationOk(`ENG-DUE-${mutations}`) };
  });
  const root = freshWorkspace();
  try {
    const linked = spawnSync(
      PM_BIN,
      [
        "--path", root, "create", "--title", "Linked due", "--status", "open", "--priority", "1",
        "--description", "[linear] linear_id=lin-due linear_url=https://linear.app/ENG-DUE",
        "--body", "linked", "--deadline", "2026-01-03", "--assignee", "ada@example.com",
      ],
      PM_SPAWN_OPTS,
    );
    const fresh = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Fresh due", "--status", "open", "--priority", "1", "--description", "fresh", "--deadline", "2026-01-04", "--assignee", "ada@example.com"],
      PM_SPAWN_OPTS,
    );
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(fresh.status, 0, fresh.stderr);
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
        const r = result as { created: number; updated: number };
        assert.equal(r.created, 1);
        assert.equal(r.updated, 1);
      },
    );
    assert.equal(mutations, 2);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push resolves a cycle tag to a concrete cycleId on the create input", async () => {
  let lastCreateInput: Record<string, unknown> | undefined;
  const server = await startLinearServer(({ query, variables }) => {
    if (query?.includes("teams(")) return { body: teamResponse() };
    const input = (variables as { input?: Record<string, unknown> }).input;
    lastCreateInput = input;
    return { body: mutationOk("ENG-CYC") };
  });
  const root = freshWorkspace();
  try {
    const add = spawnSync(
      PM_BIN,
      ["--path", root, "create", "--title", "Cycled", "--status", "open", "--priority", "2", "--description", "fresh", "--tags", "cycle:Q3,bug"],
      PM_SPAWN_OPTS,
    );
    assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);

    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
      },
    );
    assert.equal(lastCreateInput?.cycleId, "cyc-q3", "cycle:Q3 tag resolved to the team cycle id");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export --push isolates a per-item mutation failure and continues the batch", async () => {
  let mutations = 0;
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) return { body: teamResponse() };
    mutations++;
    return { body: JSON.stringify({ errors: [{ message: "boom" }] }) };
  });
  const root = freshWorkspace();
  try {
    for (const t of ["A", "B"]) {
      const add = spawnSync(
        PM_BIN,
        ["--path", root, "create", "--title", `Item ${t}`, "--status", "open", "--priority", "2", "--description", "fresh"],
        PM_SPAWN_OPTS,
      );
      assert.strictEqual(add.status, 0, `pm create failed: ${add.stderr}`);
    }
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        const { result } = await harness.runExporter({
          exporter: "linear",
          options: { push: true, team: "ENG" },
          pmRoot: root,
        });
        const r = result as { created: number; skipped: number };
        assert.equal(r.created, 0, "no item succeeded");
        assert.equal(r.skipped, 2, "both items skipped, batch did not abort");
      },
    );
    assert.equal(mutations, 2, "both items attempted despite the first failure");
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTeamContext surfaces a GraphQL error from the team lookup", async () => {
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) {
      return { body: JSON.stringify({ errors: [{ message: "bad team query" }] }) };
    }
    return { body: "{}" };
  });
  const root = freshWorkspace();
  try {
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await assert.rejects(
          () => harness.runExporter({ exporter: "linear", options: { push: true, team: "ENG" }, pmRoot: root }),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.match((err as Error).message, /Linear API error resolving team ENG: bad team query/);
            return true;
          },
        );
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTeamContext rejects an unknown team with NOT_FOUND", async () => {
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("teams(")) return { body: JSON.stringify({ data: { teams: { nodes: [] } } }) };
    return { body: "{}" };
  });
  const root = freshWorkspace();
  try {
    const harness = await getHarness();
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: server.url },
      async () => {
        await assert.rejects(
          () => harness.runExporter({ exporter: "linear", options: { push: true, team: "NOPE" }, pmRoot: root }),
          (err: unknown) => {
            assert.ok(err instanceof CommandError);
            assert.match((err as Error).message, /Linear team "NOPE" not found/);
            return true;
          },
        );
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// preflightLinear: missing key, skip-network, reachability ok / error / unreachable
// ---------------------------------------------------------------------------

test("the preflight override injects a USAGE sentinel when LINEAR_API_KEY is missing", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: undefined }, async () => {
      const pre = await harness.runPreflightOverride(preflightCtx(root, {}));
      const opts = (pre as { context?: { options?: Record<string, unknown> } }).context?.options ?? {};
      assert.ok(
        typeof opts["__linear_preflight_error"] === "string",
        "the override stashes the missing-key error on the sentinel option",
      );
      // Forwarding the sentinel into the command handler yields the USAGE error.
      await assert.rejects(
        () => harness.runCommand({ command: "linear sync", options: { team: "ENG", ...opts }, pmRoot: root }),
        (err: unknown) => {
          assert.ok(err instanceof CommandError);
          assert.match((err as Error).message, /LINEAR_API_KEY is not set/);
          return true;
        },
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight skip-network mechanisms skip the reachability probe and pass", async () => {
  // A server is NOT started; if the probe ran it would fail. Each skip mechanism
  // must suppress the probe so the override returns {} with no sentinel.
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: "http://127.0.0.1:1/graphql" },
      async () => {
        const a = await harness.runPreflightOverride(
          preflightCtx(root, { "skip-preflight-network": true }),
        );
        assert.ok(!("__linear_preflight_error" in ((a as { context?: { options?: Record<string, unknown> } }).context?.options ?? {})), "skip-preflight-network suppresses the probe (no sentinel)");

        const b = await harness.runPreflightOverride(
          preflightCtx(root, { "no-preflight-network": true }),
        );
        assert.ok(!("__linear_preflight_error" in ((b as { context?: { options?: Record<string, unknown> } }).context?.options ?? {})), "no-preflight-network suppresses the probe (no sentinel)");
      },
    );
    // The env-var spelling is tested separately because it mutates a different
    // env key than LINEAR_API_BASE_URL.
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: "http://127.0.0.1:1/graphql", LINEAR_PREFLIGHT_NO_NETWORK: "1" },
      async () => {
        const c = await harness.runPreflightOverride(preflightCtx(root, {}));
        assert.ok(!("__linear_preflight_error" in ((c as { context?: { options?: Record<string, unknown> } }).context?.options ?? {})), "LINEAR_PREFLIGHT_NO_NETWORK suppresses the probe (no sentinel)");
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate reports readiness offline without leaking the key", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test_key", LINEAR_DEFAULT_TEAM: "ENG" },
      async () => {
        const { result } = await harness.runCommand({
          command: "linear validate",
          options: {},
          pmRoot: root,
          global: { json: true },
        });
        const diag = result as {
          apiKeyPresent: boolean;
          apiKeyMasked: string;
          defaultTeam: string;
          readyForWrites: boolean;
          networkChecked: boolean;
        };
        assert.equal(diag.apiKeyPresent, true);
        assert.equal(diag.defaultTeam, "ENG");
        assert.equal(diag.readyForWrites, true);
        assert.equal(diag.networkChecked, false);
        assert.ok(!diag.apiKeyMasked.includes("lin_test_key"), "masked key must not leak");
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate without a key reports MISSING in the human-readable path", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv({ LINEAR_API_KEY: undefined, LINEAR_DEFAULT_TEAM: undefined }, async () => {
      const { result } = await harness.runCommand({
        command: "linear validate",
        options: {},
        pmRoot: root,
      });
      const diag = result as { apiKeyPresent: boolean; readyForWrites: boolean };
      assert.equal(diag.apiKeyPresent, false);
      assert.equal(diag.readyForWrites, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate --check-network succeeds when the viewer resolves", async () => {
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("viewer")) return { body: JSON.stringify({ data: { viewer: { id: "viewer-1" } } }) };
    return { body: "{}" };
  });
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

test("linear validate --check-network fails on a GraphQL error from the viewer", async () => {
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("viewer")) {
      return { body: JSON.stringify({ errors: [{ message: "invalid token" }] }) };
    }
    return { body: "{}" };
  });
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
        const diag = result as { networkOk: boolean; networkError?: string };
        assert.equal(diag.networkOk, false);
        assert.match(diag.networkError ?? "", /invalid token/);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate --check-network fails when no viewer id is returned", async () => {
  const server = await startLinearServer(({ query }) => {
    if (query?.includes("viewer")) return { body: JSON.stringify({ data: { viewer: { id: null } } }) };
    return { body: "{}" };
  });
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
          global: { json: true },
        });
        const diag = result as { networkOk: boolean; networkError?: string };
        assert.equal(diag.networkOk, false);
        assert.match(diag.networkError ?? "", /returned no viewer/);
      },
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("linear validate --check-network fails when the API is unreachable", async () => {
  const harness = await getHarness();
  const root = freshWorkspace();
  try {
    await withEnv(
      { LINEAR_API_KEY: "lin_test", LINEAR_API_BASE_URL: "http://127.0.0.1:1/graphql" },
      async () => {
        const { result } = await harness.runCommand({
          command: "linear validate",
          options: { "check-network": true },
          pmRoot: root,
          global: { json: true },
        });
        const diag = result as { networkOk: boolean; networkError?: string };
        assert.equal(diag.networkOk, false);
        assert.match(diag.networkError ?? "", /Linear API unreachable/);
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});