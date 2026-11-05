/** Typed create boundaries clear scope through public SDK unset options. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient, normalizeItemId, readSettings } from "@unbrained/pm-cli/sdk";
import { buildAtomicImportMutations, buildItemPlan, syncLinearIssues, type LinearIssue } from "../dist/index.js";

const sdk = JSON.parse(await readFile(new URL("../node_modules/@unbrained/pm-cli/package.json", import.meta.url), "utf8")) as { version: string };
// GH-1577 made SDK focus inheritance opt-in in 2026.10.26; older hosts inherit it implicitly.
const focusOptions = Number(sdk.version.split(".").map((part) => part.padStart(2, "0")).join("")) >= 20261026 ? { inheritFocus: true } : {};

for (const route of ["forward", "shared-plan"] as const) {
  test(`typed parent clear: ${route} creates without ambient relationships`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "linear-typed-clear-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pm = new PmClient({ pmRoot: root, cwd: root, noExtensions: true, author: process.env.PM_AUTHOR ?? "pm-linear" });
    await pm.init("typed-clear");
    const anchor = await pm.create({ title: "Ambient scope", type: "Epic", assignee: "Peer" });
    await pm.update(anchor.item.id, { goal: anchor.item.id, objective: anchor.item.id, sprint: "ambient", release: "ambient" });
    await pm.focus(anchor.item.id);
    const inherited = (await pm.create({ title: "Ambient inheritance control", ...focusOptions })).item;
    assert.equal(inherited.parent, anchor.item.id, "the fixture must exercise ambient parent inheritance");
    const issue: LinearIssue = { id: route, identifier: "ENG-1", title: "Imported", description: "Body", priority: 2, dueDate: null,
      state: { name: "Queue", type: "unstarted" }, labels: { nodes: [] } };
    let id: string;
    if (route === "forward") {
      const result = await syncLinearIssues({ team: "ENG", limit: 1 }, root, { fetchIssues: async () => [issue] });
      assert.equal(result.created, 1);
      assert.equal(result.skipped, 0);
      id = result.importResults![0].id!;
    } else {
      const settings = await readSettings(root);
      const plan = buildAtomicImportMutations("ENG", { ...buildItemPlan(issue, {}), identifier: issue.identifier, linearId: issue.id }, settings.id_prefix, normalizeItemId);
      const create = plan.mutations[0];
      assert.equal(create.op, "create");
      assert.ok(create.op === "create");
      id = (await pm.create({ ...create.options, id: plan.itemId, ...focusOptions })).item.id;
    }
    const actual = (await pm.get(id, { depth: "deep" })).item;
    assert.equal(actual.title, "[ENG-1] Imported");
    for (const field of ["parent", "goal", "objective", "sprint", "release", "assignee"] as const) assert.equal(actual[field], undefined, `${route}/${field}`);
  });
}
