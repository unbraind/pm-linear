/** Behavioral class reverts execute only in disposable non-git source copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-forward-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/native-reference.ts"), join(scratch, "test/native-reference.ts"));
  for (const file of ["forward-import.test.ts", "estimate-units.test.ts"]) await cp(join(source, "test", file), join(scratch, "test", file));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const mutants = [
    { name: "unchanged status is resubmitted, including repeated close", file: "forward-import.test.ts", pattern: "forward-only title", failure: "2",
      before: 'if (unset.length) values.unset = unset;', after: 'if (unset.length) values.unset = unset; if (observed) values.status = status;' },
    { name: "later item failure rolls back earlier completed writes", file: "forward-import.test.ts", pattern: "forward-only title", failure: "closed",
      before: '// Never rewrite an earlier success or a peer\'s state to compensate for a later error.',
      after: 'for (const target of targets) if (results.some((row) => row.id === target.id && row.action === "updated") && target.before?.version) await pm.restore(target.id, String(target.before.version));' },
    { name: "dependent plan ignores a skipped prerequisite", file: "forward-import.test.ts", pattern: "skipped prerequisite", failure: "1",
      before: 'prerequisites.get(dependent)?.add(required);', after: 'void required;' },
    { name: "dependent mutation omits its immediate revision reread", file: "estimate-units.test.ts", pattern: "forward retry revalidates", failure: "1",
      before: 'current = await observeEstimateTarget(pmRoot, id);\n      if (current.revision !== expected) {',
      after: 'current = await observeEstimateTarget(pmRoot, id);\n      if (false) {' },
    { name: "native preview includes installed runtime code pointers as tracker data", file: "forward-import.test.ts", pattern: "forward-only title", failure: "1",
      before: `await readImportMirror(pmRoot, [id], async (copy) => {
          await assertSdkFunction(sdk.previewItemMutations, "previewItemMutations")({ pmRoot: copy,
            transactionId: \`linear-preview-\${schemaDigest([id, expected, values])}\`, author,
            mutations: [{ op: "update", id, options: values }] });
          return { synced: 0, created: 0, updated: 0, skipped: 0, team: options.team };
        });`,
      after: `await assertSdkFunction(sdk.previewItemMutations, "previewItemMutations")({ pmRoot,
          transactionId: \`linear-preview-\${schemaDigest([id, expected, values])}\`, author,
          mutations: [{ op: "update", id, options: values }] });` },
  ];
  const vars = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, `test/${mutant.file}`], { cwd: scratch, env: vars, encoding: "utf8", timeout: 600000 });
    assert.equal(result.status, 1, `${mutant.name} must fail behaviorally`);
    assert.match(result.stdout + result.stderr, /AssertionError/);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  await writeFile(join(scratch, "index.ts"), original);
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=forward-only title|skipped prerequisite|forward retry revalidates", "test/forward-import.test.ts", "test/estimate-units.test.ts"], { cwd: scratch, env: vars, encoding: "utf8", timeout: 600000 });
  assert.equal(fixed.status, 0, (fixed.stdout + fixed.stderr).slice(-3000));
  assert.match(fixed.stdout, /tests 3/);
  const report = { reverted: results, fixed: { passed: 3, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
