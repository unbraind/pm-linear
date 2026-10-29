/** Compare built modules against immutable public tracker snapshots. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import * as candidate from "../dist/index.js";

const [baselinePath, ...trackerPaths] = process.argv.slice(2);
assert.ok(baselinePath && trackerPaths.length > 0,
  "Usage: node test/sdk-adoption-differential.ts BASELINE_MODULE READ_ONLY_TRACKER...");
const baselineModule = resolve(baselinePath);
const baseline = await import(pathToFileURL(baselineModule).href) as typeof candidate;
const trackers = trackerPaths.map((root) => resolve(root));
for (const root of trackers) {
  const location = relative(tmpdir(), root);
  assert.ok(location && !location.startsWith("..") && !isAbsolute(location),
    "Use only scratch tracker copies in the temporary directory");
  for (const entry of [root, ...(await readdir(root, { recursive: true })).map((name) => join(root, name))]) {
    assert.equal((await stat(entry)).mode & 0o222, 0, "Scratch snapshots must be read-only");
  }
}

/** Hash file names and bytes so caches and accidental writes also fail. */
async function snapshot(root: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of entries) {
    const bytes = await readFile(file);
    hash.update(JSON.stringify([relative(root, file), bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const metadata = {
  teams: { nodes: [{
    id: "team", key: "AUDIT", cyclesEnabled: true, triageEnabled: false,
    issueEstimationType: "fibonacci", defaultIssueState: { id: "todo" },
    states: {
      nodes: [{ id: "todo", name: "Ready", type: "unstarted" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }] },
  issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
let requests = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    assert.ok(!body.includes("mutation"));
    requests++;
    res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
    res.end(JSON.stringify({ data: metadata }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.LINEAR_API_KEY = "synthetic-key";
process.env.LINEAR_API_BASE_URL = `http://127.0.0.1:${address.port}/graphql`;
process.env.GIT_CEILING_DIRECTORIES = trackers.map((root) => dirname(dirname(root))).join(delimiter);
process.env.PATH = "";
const results = [];
try {
  for (const root of trackers) {
    const initial = await snapshot(root);
    const outputs: Array<{
      exported: unknown;
      schema: candidate.LinearSchemaReport;
      planned: candidate.SyncResult;
    }> = [];
    for (const mod of [baseline, candidate]) {
      const harness = await createExtensionTestHarness(mod.default, {
        name: "pm-linear", capabilities: ["commands", "schema", "importers", "preflight"],
      });
      const exported = await harness.runExporter({
        exporter: "linear", pmRoot: root, options: {}, global: { json: true },
      });
      const schema = await mod.negotiateLinearSchema({ team: "AUDIT" }, root);
      const planned = await mod.syncLinearIssues(
        { team: "AUDIT", limit: 1, atomic: true, forwardOnly: true, dryRun: true }, root,
        { fetchIssues: async () => [{
          id: "audit-issue", identifier: "AUDIT-1", title: "Synthetic provider issue",
          description: "Synthetic", priority: 2,
          state: { name: "Ready", type: "unstarted" }, labels: { nodes: [] },
          dueDate: null, cycle: null, url: "https://linear.app/issue/AUDIT-1",
        }] },
      );
      outputs.push({ exported: exported.result, schema, planned });
      assert.equal(await snapshot(root), initial, "Snapshot bytes changed");
    }
    assert.deepEqual(outputs[1], outputs[0]);
    const exported = outputs[0].exported as { exported: number };
    assert.ok(exported.exported > 0, "The public tracker must contain items");
    results.push({
      tracker: basename(dirname(dirname(root))), items: exported.exported,
      comparisons: 3, identical: true, unchanged: true,
    });
  }
  const baselineBytes = await readFile(baselineModule);
  const candidateBytes = await readFile(new URL("../dist/index.js", import.meta.url));
  console.log(JSON.stringify({
    results, readOnlyHttpRequests: requests, intentionalDifferences: [],
    runtimeIdentical: baselineBytes.equals(candidateBytes),
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
