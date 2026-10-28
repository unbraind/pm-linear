/** Verify imports leave caller stdin untouched, including on typed refusals. */
import assert from "node:assert/strict";
import { syncLinearIssues, type LinearIssue } from "../index.ts";

const [root, atomic, field] = process.argv.slice(2);
const issue: LinearIssue = {
  id: "stdin-provider", identifier: "STDIN-1", title: "Literal input", description: field === "body" ? "-" : "--",
  priority: 2, state: { name: "Queue", type: "unstarted" }, labels: { nodes: [{ name: "none" }] },
  dueDate: null, cycle: null, assignee: { name: field === "assignee" ? "none" : "-", email: null },
};
let refusal: { code?: unknown; field?: unknown } | undefined;
try {
  await syncLinearIssues({ team: "STDIN", limit: 1, atomic: atomic === "true" }, root, { fetchIssues: async () => [issue] });
} catch (error: unknown) {
  assert.ok(error instanceof Error);
  refusal = error as typeof refusal;
}
if (field === "safe") assert.equal(refusal, undefined);
else { assert.equal(refusal?.code, "unrepresentable_value"); assert.equal(refusal?.field, field); }
let remaining = "";
for await (const chunk of process.stdin) remaining += String(chunk);
assert.equal(remaining, "caller-stdin-is-not-provider-data\n");
process.stdout.write(JSON.stringify({ passed: true, field, atomic: atomic === "true" }));
