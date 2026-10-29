/** Revert SDK payload, CLI compactness and assignment-guidance regressions only in owned copies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-result-revert-"));
try {
  await mkdir(join(scratch, "test"));
  await cp(join(source, "test/sync-result-contract.test.ts"), join(scratch, "test/sync-result-contract.test.ts"));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8"), readme = await readFile(join(source, "README.md"), "utf8");
  const boundary = 'const result = { ...applied, issues, importResults:';
  const mutants = [
    { name: "sync discards all fetched issues", before: boundary, after: 'const result = { ...applied, issues: [], importResults:', pattern: "sync fetched" },
    { name: "atomic flag discards fetched issues", before: boundary, after: 'const result = { ...applied, issues: options.atomic ? [] : issues, importResults:', pattern: "sync fetched" },
    { name: "dry-run discards fetched issues", before: boundary, after: 'const result = { ...applied, issues: options.dryRun ? [] : issues, importResults:', pattern: "sync fetched" },
    { name: "local filters redefine fetched membership", before: boundary, after: 'const result = { ...applied, issues: issues.filter((issue) => prepared.some((entry) => entry.linearId === issue.id)), importResults:', pattern: "sync fetched" },
    { name: "failed targets disappear from fetched data", before: boundary, after: 'const result = { ...applied, issues: applied.importResults?.some((row) => row.code === "import_failed") ? [] : issues, importResults:', pattern: "sync fetched" },
    { name: "native normalization leaks into fetched payloads", before: boundary, after: 'const result = { ...applied, issues: issues.map((issue) => ({ ...issue, title: issue.title.trim() })), importResults:', pattern: "sync fetched" },
    { name: "execution sorting replaces provider ordering", before: boundary, after: 'const result = { ...applied, issues: [...issues].sort((a, b) => a.id.localeCompare(b.id)), importResults:', pattern: "sync fetched" },
    ...[0, 1, 2].map((occurrence) => ({ name: `CLI route ${occurrence} leaks fetched payloads`, before: 'dryRun: Boolean(result.dryRun)', after: 'issues: result.issues, dryRun: Boolean(result.dryRun)', occurrence, pattern: "assignment clearing" })),
    { name: "legacy omitted assignees incorrectly retain local values", before: 'if (observed) unset.push(key);', after: 'if (observed && (key !== "assignee" || readLinearEstimate(entry.tags).contract)) unset.push(key);', pattern: "assignment clearing" },
    { name: "README promises legacy assignment preservation", file: "README.md", before: 'Every payload family clears absent mapped', after: 'Omitted optional assignments retain the current local value for legacy payloads; scale-aware imports clear absent mapped', pattern: "assignment clearing" },
  ];
  const variables = { PATH: process.env.PATH ?? "", HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    await writeFile(join(scratch, "index.ts"), original); await writeFile(join(scratch, "README.md"), readme);
    const name = ("file" in mutant ? mutant.file : undefined) ?? "index.ts", text = name === "README.md" ? readme : original;
    let offset = -1; for (let index = 0; index <= ("occurrence" in mutant ? mutant.occurrence : 0); index++) offset = text.indexOf(mutant.before, offset + 1);
    assert.ok(offset >= 0, mutant.name);
    await writeFile(join(scratch, name), text.slice(0, offset) + mutant.after + text.slice(offset + mutant.before.length));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, "test/sync-result-contract.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: must fail behaviorally`); assert.match(run.stdout + run.stderr, /AssertionError/);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
  }
  await writeFile(join(scratch, "index.ts"), original); await writeFile(join(scratch, "README.md"), readme);
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/sync-result-contract.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
  assert.equal(fixed.status, 0, (fixed.stdout + fixed.stderr).slice(-2000)); assert.match(fixed.stdout, /tests 2/);
  const report = { reverted: results, fixed: { passed: 2, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
