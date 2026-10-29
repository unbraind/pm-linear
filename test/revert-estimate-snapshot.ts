/** Prove incoherent planning observations and revision fallback fail in owned disposable copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-snapshot-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/estimate-units.test.ts"), join(scratch, "test/estimate-units.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const mutants = [
    { name: "revision captured independently of the planning document", pattern: "planning images", failure: "a mixed planning image must be skipped",
      before: "if (schemaDigest(planned) === schemaDigest(observed)) revisions.set(item.id, target.revision);",
      after: "revisions.set(item.id, target.revision);" },
    { name: "missing planning revision silently adopts current target", pattern: "missing planning revisions", failure: "an existing target requires a paired revision",
      before: "const expected = entry.match?.id ? revisions.get(entry.match.id) : before.revision;",
      after: "const expected = revisions.get(entry.match?.id ?? \"\") ?? before.revision;" },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    assert.ok(original.includes(mutant.before), mutant.name);
    await writeFile(join(scratch, "index.ts"), original.replace(mutant.before, mutant.after));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, "test/estimate-units.test.ts"],
      { cwd: scratch, encoding: "utf8", env: variables, timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: behavioral revert must fail`);
    assert.ok((run.stdout + run.stderr).includes(mutant.failure), mutant.name);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=planning images|missing planning revisions", "test/estimate-units.test.ts"],
    { cwd: source, encoding: "utf8", env: variables, timeout: 600000 });
  assert.equal(fixed.status, 0, "Unmodified production implementation must pass");
  assert.match(fixed.stdout, /tests 2/);
  const report = { reverted: results, fixed: { passed: 2, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
