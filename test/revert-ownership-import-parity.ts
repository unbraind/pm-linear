/** Prove acquisition and writer-selection regressions fail in disposable copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutState } from "./checkout-state.ts";

const source = resolve(import.meta.dirname, "..");
const checkoutBefore = checkoutState(source);
const scratch = await mkdtemp(join(tmpdir(), "linear-ownership-parity-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/native-reference.ts"), join(scratch, "test/native-reference.ts"));
  await cp(join(source, "test/ownership.test.ts"), join(scratch, "test/ownership.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const mutants = [
    { name: "ownership acquisition omits team metadata", before: "issue(id: $id) { ${LINEAR_IMPORT_FIELDS} }",
      after: "issue(id: $id) { id identifier title description priority estimate updatedAt state { name type } labels(first: 128) { nodes { name } pageInfo { hasNextPage } } dueDate cycle { name } assignee { name email } project { name } customer { name } url }" },
    { name: "previewLinearOwnership selects the legacy writer for a scale-aware issue",
      before: "fetchIssues: async () => [issue]",
      after: "fetchIssues: async () => [{ ...issue, team: undefined }]" },
    { name: "legacy projection loses isolated repeat-closure compatibility",
      before: "projectionForce: !issue.team",
      after: "projectionForce: false", pattern: "ownership retains isolated", failure: "projection_failed" },
  ];
  const args = ["--test", "--test-concurrency=1", "--test-name-pattern=ownership shares every import writer", "test/ownership.test.ts"];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const command = mutant.pattern ? args.map((arg) => arg.startsWith("--test-name-pattern=") ? `--test-name-pattern=${mutant.pattern}` : arg) : args;
    const run = spawnSync(process.execPath, command, { cwd: scratch, encoding: "utf8", env: variables, timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: behavioral revert must fail`);
    assert.ok((run.stdout + run.stderr).includes(mutant.failure ?? "projection must equal SDK-read imported state"), mutant.name);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  const fixedArgs = args.map((arg) => arg.startsWith("--test-name-pattern=") ? "--test-name-pattern=ownership shares every import writer|ownership retains isolated" : arg);
  const fixed = spawnSync(process.execPath, fixedArgs, { cwd: source, encoding: "utf8", env: variables, timeout: 600000 });
  assert.equal(fixed.status, 0, "Unmodified production implementation must pass");
  assert.match(fixed.stdout, /tests 2/);
  const reviewedCheckoutMutated = checkoutState(source) !== checkoutBefore;
  assert.equal(reviewedCheckoutMutated, false, "The harness must not change the reviewed checkout.");
  const report = { reverted: results, fixed: { passed: 2, failed: 0 }, reviewedCheckoutMutated };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
