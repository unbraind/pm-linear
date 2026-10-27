/** Schema negotiation exercises real SDK trackers and the HTTP wire without git. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { LinearSourceRefusal, LinearSchemaRefusal, negotiateLinearSchema, syncLinearIssues, resolveStatus, type LinearSchemaReport } from "../index.ts";

/** Complete provider metadata with deliberately custom state names. */
function metadata() {
  return {
    teams: { nodes: [{
      id: "team", key: "ENG", cyclesEnabled: true, triageEnabled: false,
      issueEstimationType: "fibonacci", defaultIssueState: { id: "todo" },
      states: {
        nodes: [{ id: "todo", name: "Ready", type: "unstarted" }, { id: "review", name: "Review", type: "started" }],
        pageInfo: { hasNextPage: false, endCursor: null as string | null },
      },
    }] },
    issueLabels: { nodes: [{ id: "bug", name: "bug" }], pageInfo: { hasNextPage: false, endCursor: null as string | null } },
  };
}

/** Real tracker and network responder; a missing git executable proves portability. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "linear-schema-"));
  const pm = new PmClient({ cwd: root, pmRoot: root, noExtensions: true, author: "fixture" });
  await pm.init("schema-fixture");
  await pm.create({ title: "Existing local context", id: "existing", createMode: "progressive" });
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const state = {
    data: metadata() as unknown,
    errors: undefined as unknown,
    status: 200,
    rawBody: undefined as string | undefined,
    issues: [] as unknown[],
    onRequest: undefined as ((query: string, variables: Record<string, unknown>) => void) | undefined,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const request = JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      state.onRequest?.(request.query, request.variables);
      res.writeHead(state.status, { "Content-Type": "application/json", "Connection": "close" });
      res.end(state.rawBody ?? JSON.stringify(request.query.includes("LinearSchema")
        ? { data: state.data, errors: state.errors }
        : { data: { issues: { nodes: state.issues, pageInfo: { hasNextPage: false, endCursor: null } } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const changes: Record<string, string> = {
    LINEAR_API_KEY: "synthetic-key", LINEAR_API_BASE_URL: `http://127.0.0.1:${address.port}/graphql`,
    GIT_CEILING_DIRECTORIES: tmpdir(), PATH: root,
  };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, pm, state, requests };
}

/** Capture durable item and history bytes, excluding SDK runtime caches. */
async function durable(root: string): Promise<string[]> {
  const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".toon") || name.endsWith(".jsonl")).sort();
  return Promise.all(files.map(async (name) => `${name}:${await readFile(join(root, name), "utf8")}`));
}

/** Require a typed, actionable refusal and never accept an unhandled exception. */
function refusal(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LinearSchemaRefusal);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 20);
    return true;
  };
}

test("schema command and SDK agree without git, with complete custom status mapping", async (t) => {
  const { root, pm, requests } = await fixture(t);
  await pm.schemaAddStatus("reviewing", { role: ["active"] });
  const before = await durable(root);
  const report = await negotiateLinearSchema({ team: "eng", statusMap: { Review: "reviewing" } }, root);
  assert.equal(report.formatVersion, 1);
  assert.match(report.schemaVersion, /^linear-schema-v1:[a-f0-9]{64}$/);
  assert.equal(report.states.find((state) => state.id === "review")?.status, "reviewing");
  assert.equal(report.counts.labels, 1);
  assert.ok(JSON.stringify(report).length < 1500);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  const result = await harness.runCommand({ command: "linear schema", pmRoot: root, options: { team: "ENG", statusMap: "Review=reviewing", schemaVersion: report.schemaVersion }, global: { json: true } });
  assert.deepEqual(result.result, report);
  const plain = await harness.runCommand({ command: "linear schema", pmRoot: root, options: { team: "ENG" }, global: {} });
  assert.equal((plain.result as { compatible: boolean }).compatible, true);
  await assert.rejects(harness.runCommand({ command: "linear schema", pmRoot: root, options: {}, global: {} }), refusal("mapping_invalid"));
  assert.ok(requests.every(({ query }) => !query.includes("mutation")));
  assert.match(requests[0].query, /issueLabels.*first: 250/s);
  assert.match(requests[0].query, /team: \{null: true\}/);
  assert.deepEqual(await durable(root), before);
});

for (const change of ["deleted label", "renamed label", "renamed state", "state type", "settings", "default state", "team identity", "local statuses", "override"] as const) {
  test(`${change} invalidates old plans before local writes`, async (t) => {
    const { root, pm, state, requests } = await fixture(t);
    const report = await negotiateLinearSchema({ team: "ENG" }, root);
    const data = metadata();
    const team = data.teams.nodes[0];
    let statusMap: Record<string, string> | undefined;
    if (change === "deleted label") data.issueLabels.nodes = [];
    if (change === "renamed label") data.issueLabels.nodes[0].name = "defect";
    if (change === "renamed state") team.states.nodes[0].name = "Queued";
    if (change === "state type") team.states.nodes[0].type = "started";
    if (change === "settings") team.triageEnabled = true;
    if (change === "default state") team.defaultIssueState.id = "review";
    if (change === "team identity") team.id = "replacement-team";
    if (change === "local statuses") await pm.schemaAddStatus("reviewing", { role: ["active"] });
    if (change === "override") statusMap = { Ready: "blocked" };
    state.data = data;
    const before = await durable(root);
    await assert.rejects(syncLinearIssues({ team: "ENG", limit: 10, atomic: true, schemaVersion: report.schemaVersion, statusMap }, root), (error: unknown) => {
      refusal("schema_drift")(error);
      assert.ok((error as LinearSchemaRefusal).report?.schemaVersion);
      return true;
    });
    assert.equal(requests.filter(({ query }) => query.includes("issues(")).length, 0);
    assert.deepEqual(await durable(root), before);
  });
}

test("metadata order is stable; independent pagination covers all states and labels", async (t) => {
  const { root, state, requests } = await fixture(t);
  const report = await negotiateLinearSchema({ team: "ENG", statusMap: { Review: "in_progress", Ready: "open" } }, root);
  const data = metadata();
  data.teams.nodes[0].states.nodes.reverse();
  state.data = data;
  assert.equal((await negotiateLinearSchema({ team: "ENG", statusMap: { Ready: "open", Review: "in_progress" } }, root)).schemaVersion, report.schemaVersion);
  state.onRequest = (_query, variables) => {
    const data = metadata();
    if (!variables.statesAfter) {
      data.teams.nodes[0].states.nodes = data.teams.nodes[0].states.nodes.slice(0, 1);
      data.teams.nodes[0].states.pageInfo = { hasNextPage: true, endCursor: "state-next" };
    } else data.teams.nodes[0].states.nodes = data.teams.nodes[0].states.nodes.slice(1);
    if (!variables.labelsAfter) data.issueLabels.pageInfo = { hasNextPage: true, endCursor: "label-next" };
    else data.issueLabels.nodes = [{ id: "feature", name: "feature" }];
    state.data = data;
  };
  const paginated = await negotiateLinearSchema({ team: "ENG" }, root);
  assert.equal(paginated.counts.states, 2);
  assert.equal(paginated.counts.labels, 2);
  assert.equal(requests.at(-1)?.variables.statesAfter, "state-next");
  assert.equal(requests.at(-1)?.variables.labelsAfter, "label-next");
});

for (const denied of ["missing key", "HTTP 401", "HTTP 403", "GraphQL", "hidden team"] as const) {
  test(`${denied} refuses before local writes or issue fetch`, async (t) => {
    const { root, state, requests } = await fixture(t);
    if (denied === "missing key") delete process.env.LINEAR_API_KEY;
    if (denied === "HTTP 401") state.status = 401;
    if (denied === "HTTP 403") state.status = 403;
    if (denied === "GraphQL") state.errors = [{ message: "forbidden synthetic-key" }];
    if (denied === "hidden team") state.data = { ...metadata(), teams: { nodes: [] } };
    const before = await durable(root);
    const action = denied === "missing key" ? negotiateLinearSchema({ team: "ENG" }, root) : syncLinearIssues({ team: "ENG", limit: 5 }, root);
    await assert.rejects(action, (error: unknown) => {
      refusal("access_denied")(error);
      assert.doesNotMatch((error as Error).message, /synthetic-key/);
      return true;
    });
    assert.ok(requests.every(({ query }) => query.includes("LinearSchema")));
    assert.deepEqual(await durable(root), before);
  });
}

for (const [name, mutate] of [
  ["null data", () => null],
  ["nonobject data", () => []],
  ["missing teams", () => ({})],
  ["missing settings", () => { const d = metadata(); return { ...d, teams: { nodes: [{ id: "team", key: "ENG" }] } }; }],
  ["wrong team", () => { const d = metadata(); d.teams.nodes[0].key = "OTHER"; return d; }],
  ["missing string", () => { const d = metadata(); d.teams.nodes[0].issueEstimationType = ""; return d; }],
  ["invalid page", () => { const d = metadata(); return { ...d, issueLabels: { nodes: [], pageInfo: {} } }; }],
  ["invalid nodes", () => ({ ...metadata(), issueLabels: { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } } })],
  ["invalid cursor", () => ({ ...metadata(), issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 42 } } })],
  ["empty next page", () => { const d = metadata(); d.issueLabels.nodes = []; d.issueLabels.pageInfo = { hasNextPage: true, endCursor: "next" }; return d; }],
  ["missing next cursor", () => { const d = metadata(); d.issueLabels.pageInfo.hasNextPage = true; return d; }],
  ["duplicate labels", () => { const d = metadata(); d.issueLabels.nodes.push(d.issueLabels.nodes[0]); return d; }],
  ["duplicate states", () => { const d = metadata(); d.teams.nodes[0].states.nodes.push(d.teams.nodes[0].states.nodes[0]); return d; }],
  ["bad label name", () => { const d = metadata(); d.issueLabels.nodes[0].name = ""; return d; }],
] satisfies Array<[string, () => unknown]>) {
  test(`${name} metadata fails closed`, async (t) => {
    const { root, state } = await fixture(t);
    state.data = mutate();
    await assert.rejects(negotiateLinearSchema({ team: "ENG" }, root), name === "nonobject data" ? (error: unknown) => {
      assert.ok(error instanceof LinearSourceRefusal);
      assert.equal(error.code, "source_invalid");
      assert.equal(error.field, "response.data");
      assert.equal(error.exitCode, 2);
      return true;
    } : refusal("metadata_incomplete"));
  });
}

for (const statusMap of ([{ Missing: "open" }, { Ready: "unregistered" }, { Ready: "open", ready: "blocked" }] as Array<Record<string, string>>)) {
  test(`invalid mapping ${JSON.stringify(statusMap)} refuses`, async (t) => {
    const { root } = await fixture(t);
    await assert.rejects(negotiateLinearSchema({ team: "ENG", statusMap }, root), refusal("mapping_invalid"));
  });
}

test("metadata change during issue fetch invalidates both atomic and legacy apply", async (t) => {
  const { root, state } = await fixture(t);
  const before = await durable(root);
  state.onRequest = (query) => {
    if (!query.includes("LinearSchema")) { const data = metadata(); data.issueLabels.nodes = []; state.data = data; }
  };
  for (const atomic of [true, false]) {
    state.data = metadata();
    await assert.rejects(syncLinearIssues({ team: "ENG", limit: 5, atomic }, root), refusal("schema_drift"));
  }
  assert.deepEqual(await durable(root), before);
});

test("unchanged negotiation reaches the existing atomic writer", async (t) => {
  const { root, pm, state, requests } = await fixture(t);
  state.issues = [{ id: "remote", identifier: "ENG-1", title: "Remote context", description: "Read-only provider fixture", priority: 2, state: { name: "Ready", type: "unstarted" }, labels: { nodes: [{ name: "bug" }] }, dueDate: null, cycle: null }];
  const result = await syncLinearIssues({ team: "ENG", limit: 5, atomic: true }, root);
  assert.equal(result.created, 1);
  assert.equal(result.synced, 1);
  assert.equal((await pm.listAllComplete()).count, 2);
  assert.equal(requests.filter(({ query }) => query.includes("LinearSchema")).length, 2);
});

test("connection failures and unreadable local schema have typed remedies", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(negotiateLinearSchema({ team: "ENG" }, join(root, "missing")), refusal("schema_unavailable"));
  process.env.LINEAR_API_BASE_URL = "http://127.0.0.1:1/graphql";
  await assert.rejects(negotiateLinearSchema({ team: "ENG" }, root), refusal("schema_unavailable"));
});

for (const fault of ["cursor loop", "settings drift", "team drift", "no states", "more label pages", "more state pages", "bounded output"] as const) {
  test(`discovery handles ${fault}`, async (t) => {
    const { root, pm, state } = await fixture(t);
    let count = 0;
    state.onRequest = () => {
      const data = metadata();
      if (fault === "cursor loop") data.issueLabels.pageInfo = { hasNextPage: true, endCursor: "repeated" };
      if (fault === "no states") data.teams.nodes[0].states.nodes = [];
      if (fault === "settings drift" || fault === "team drift") {
        data.issueLabels.nodes[0].id = `label-${count}`;
        data.issueLabels.pageInfo = { hasNextPage: true, endCursor: `next-${count}` };
        if (count > 0) {
          if (fault === "settings drift") data.teams.nodes[0].cyclesEnabled = false;
          else data.teams.nodes[0].id = "replacement";
        }
      }
      if (fault === "more label pages") {
        data.issueLabels.nodes[0].id = `label-${count}`;
        if (count < 2) data.issueLabels.pageInfo = { hasNextPage: true, endCursor: `next-${count}` };
      }
      if (fault === "more state pages") {
        data.teams.nodes[0].states.nodes = [{ id: `state-${count}`, name: `Ready-${count}`, type: "unstarted" }];
        if (count < 2) data.teams.nodes[0].states.pageInfo = { hasNextPage: true, endCursor: `next-${count}` };
      }
      if (fault === "bounded output") data.teams.nodes[0].states.nodes = Array.from({ length: 40 }, (_, i) => ({ id: `state-${i}`, name: `State ${i}`, type: "unstarted" }));
      count++;
      state.data = data;
    };
    if (fault === "more label pages" || fault === "more state pages") {
      const report = await negotiateLinearSchema({ team: "ENG" }, root);
      assert.equal(fault === "more label pages" ? report.counts.labels : report.counts.states, 3);
    } else if (fault === "bounded output") {
      const report = await negotiateLinearSchema({ team: "ENG" }, root);
      assert.equal(report.counts.states, 40);
      assert.equal(report.states.length, 32);
      assert.equal(report.omittedStates, 8);
    } else await assert.rejects(negotiateLinearSchema({ team: "ENG" }, root), refusal(
      fault === "cursor loop" ? "metadata_incomplete" : fault === "no states" ? "mapping_invalid" : "schema_drift"));
  });
}

test("schema-version is enforced by sync and both importer commands", async (t) => {
  const { root } = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"] });
  await assert.rejects(harness.runCommand({ command: "linear sync", pmRoot: root, options: { team: "ENG", schemaVersion: "old" }, global: { json: true } }), refusal("schema_drift"));
  for (const importer of ["linear", "linear-sync"]) {
    await assert.rejects(harness.runImporter({ importer, pmRoot: root, options: { team: "ENG", "schema-version": "old" }, global: { json: true } }), refusal("schema_drift"));
  }
});

for (const [type, name] of [["canceled", "Retired"], ["duplicate", "Duplicate"], ["unknown", "Canceled"]]) {
  test(`canonical Linear terminal mapping ${type}/${name}`, () => {
    assert.equal(resolveStatus(type, name, {}), "closed");
  });
}

/** Run actual Node code asynchronously so the parent HTTP fixture can respond. */
function runNode(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Node fixture exited ${code}: ${stderr}`));
    });
  });
}

test("documented reviewed apply retains the saved version across discovery and apply", async (t) => {
  const { root, state, requests } = await fixture(t);
  const documentation = await readFile(join(import.meta.dirname, "..", "docs", "schema-negotiation.md"), "utf8");
  const example = documentation.match(/```ts\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, "the documented TypeScript example must remain executable");
  const exampleFile = join(root, "reviewed-example.ts");
  const indexUrl = pathToFileURL(join(import.meta.dirname, "..", "index.ts")).href;
  await writeFile(exampleFile, example.replace('from "pm-linear";', `from ${JSON.stringify(indexUrl)};`) + `
const result = process.argv[3] === "discover"
  ? await discoverTeamSchema(process.argv[2])
  : await importReviewedTeam(process.argv[2], process.argv[3]);
console.log(JSON.stringify(result));
`);
  const before = await durable(root);
  const report = JSON.parse(await runNode([exampleFile, root, "discover"])) as LinearSchemaReport;
  assert.equal(report.compatible, true);
  assert.equal(requests.length, 1, "discovery must not fetch issues or apply");
  const changed = metadata();
  changed.issueLabels.nodes = [];
  state.data = changed;
  const result = JSON.parse(await runNode([exampleFile, root, report.schemaVersion])) as { refused: boolean; code: string };
  assert.equal(result.refused, true);
  assert.equal(result.code, "schema_drift");
  assert.ok(requests.every(({ query }) => query.includes("LinearSchema")), "stale reviewed apply must refuse before issue fetch");
  assert.deepEqual(await durable(root), before);
});

for (const [endpoint, diagnostic] of [
  ["not-a-url?secret=synthetic-endpoint-secret", "must be a valid https URL"],
  ["http://example.invalid/graphql?secret=synthetic-endpoint-secret", "must use https"],
] as const) {
  test(`schema endpoint validation preserves only its fixed diagnostic (${diagnostic})`, async (t) => {
    const { root, requests } = await fixture(t);
    process.env.LINEAR_API_BASE_URL = endpoint;
    await assert.rejects(negotiateLinearSchema({ team: "ENG" }, root), (error: unknown) => {
      refusal("schema_unavailable")(error);
      assert.match((error as Error).message, /Cause: LINEAR_API_BASE_URL/);
      assert.ok((error as Error).message.includes(diagnostic));
      assert.doesNotMatch((error as Error).message, /synthetic-endpoint-secret|example\.invalid|not-a-url/);
      return true;
    });
    assert.equal(requests.length, 0);
  });
}

test("schema transport refusals redact arbitrary response errors and configured queries", async (t) => {
  const { root, state } = await fixture(t);
  process.env.LINEAR_API_BASE_URL += "?secret=synthetic-query-secret";
  state.rawBody = "synthetic-response-secret is not JSON";
  await assert.rejects(negotiateLinearSchema({ team: "ENG" }, root), (error: unknown) => {
    assert.ok(error instanceof LinearSourceRefusal);
    assert.equal(error.code, "source_invalid");
    assert.equal(error.field, "response");
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /LINEAR_API_BASE_URL/);
    assert.doesNotMatch((error as Error).message, /Cause:|synthetic-query-secret|synthetic-response-secret/);
    return true;
  });
});

test("schema versions and label digests match across real English and Swedish locales", async (t) => {
  const { root, pm, state } = await fixture(t);
  await pm.schemaAddStatus("ärende", { role: ["active"] });
  await pm.schemaAddStatus("z_review", { role: ["active"] });
  const before = await durable(root);
  const data = metadata();
  data.teams.nodes[0].states.nodes = [
    { id: "state-ä", name: "Ä Ready", type: "unstarted" },
    { id: "state-z", name: "Z Review", type: "started" },
  ];
  data.issueLabels.nodes = [{ id: "label-ä", name: "Ä label" }, { id: "label-z", name: "Z label" }];
  state.data = data;
  const indexUrl = pathToFileURL(join(import.meta.dirname, "..", "index.ts")).href;
  const options = { team: "ENG", statusMap: { "Ä Ready": "ärende", "Z Review": "z_review" } };
  const source = `import { negotiateLinearSchema } from ${JSON.stringify(indexUrl)};
console.log(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale,
  report: await negotiateLinearSchema(${JSON.stringify(options)}, ${JSON.stringify(root)}) }));`;
  const reports: Array<{ locale: string; report: LinearSchemaReport }> = [];
  for (const locale of ["en_US.UTF-8", "sv_SE.UTF-8"]) {
    reports.push(JSON.parse(await runNode(["--input-type=module", "-e", source], {
      LANG: locale, LC_ALL: locale, LANGUAGE: locale,
    })) as { locale: string; report: LinearSchemaReport });
  }
  assert.notEqual(reports[0].locale, reports[1].locale, "the subprocesses must actually use different locales");
  assert.equal(reports[0].report.schemaVersion, reports[1].report.schemaVersion);
  assert.equal(reports[0].report.labels.digest, reports[1].report.labels.digest);
  assert.deepEqual(reports[0].report, reports[1].report);
  assert.deepEqual(await durable(root), before);
});
