/** Prove class regressions fail behaviorally in disposable source copies; never mutate the reviewed checkout. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const source = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "linear-boundary-reverts-"));
try {
  await mkdir(join(scratch, "test"));
  for (const name of ["import-boundaries.test.ts", "network.test.ts"]) await cp(join(source, "test", name), join(scratch, "test", name));
  await writeFile(join(scratch, "package.json"), '{"type":"module"}\n');
  await symlink(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  const original = await readFile(join(source, "index.ts"), "utf8");
  const mutants: Array<{ name: string; pattern: string; before: string; after: string; extraBefore?: string; extraAfter?: string; file?: string; occurrence?: number }> = [
    { name: "ambiguous native provenance becomes an unmatched create", pattern: "identity class: generated", before: 'const ambiguous = ambiguousLinearIds(await readPmItems(pmRoot));', after: 'const ambiguous = new Set<string>();' },
    { name: "duplicate provider identities create separate native targets", pattern: "identity class: duplicate provider", before: 'if (seen.has(entry.linearId)) ambiguous.add(entry.linearId);', after: 'void entry.linearId;' },
    { name: "sync ambiguity prefilter drops the explicit conflict", pattern: "identity class: generated", before: 'filteredResults.push(linearProvenanceConflict(issue.id));', after: 'void issue.id;' },
    { name: "unconfirmed rows no longer affect process status", pattern: "outcome class", before: '(result.unconfirmed ?? 0) > 0', after: 'false', extraBefore: 'row.action === "unconfirmed"', extraAfter: 'false' },
    { name: "observer failures incorrectly report successful process status", pattern: "outcome observer class", before: 'row.code === "import_observer_failed" || ', after: '' },
    { name: "failed native rows no longer affect process status", pattern: "outcome class", before: 'row.code === "import_failed"', after: 'false' },
    ...[0, 1, 2].map((occurrence) => ({ name: `CLI route ${occurrence} omits host exit_code`, pattern: "identity class: generated", before: '...linearImportStatus(result),\n', after: '', occurrence })),
    { name: "SDK atomic request silently accepts forward-only writes", pattern: "atomic class", before: 'assertLinearImportMode(options.atomic, options.forwardOnly);', after: '' },
    { name: "atomic-named entrypoint silently accepts forward-only writes", pattern: "atomic class", before: 'assertLinearImportMode(true, opts.forwardOnly);', after: '' },
    { name: "export submits non-unique provider targets", pattern: "identity export class", file: "network.test.ts", before: 'const applicablePayloads = payloads.filter((payload) => !payload.linearId || !ambiguous.has(payload.linearId));', after: 'const applicablePayloads = payloads;' },
    { name: "export failures omit nonzero host status", pattern: "export --push isolates", file: "network.test.ts", before: '...(skipped > 0 ? { exit_code: EXIT_CODE.GENERIC_FAILURE } : {}),', after: '' },
  ];
  const variables = { PATH: `${join(source, "node_modules/.bin")}:${process.env.PATH ?? ""}`, HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir() };
  const results = [];
  for (const mutant of mutants) {
    let offset = -1;
    for (let index = 0; index <= (mutant.occurrence ?? 0); index++) offset = original.indexOf(mutant.before, offset + 1);
    assert.ok(offset >= 0, mutant.name);
    let changed = original.slice(0, offset) + mutant.after + original.slice(offset + mutant.before.length);
    if (mutant.extraBefore !== undefined && mutant.extraAfter !== undefined) { assert.ok(changed.includes(mutant.extraBefore)); changed = changed.replace(mutant.extraBefore, mutant.extraAfter); }
    await writeFile(join(scratch, "index.ts"), changed);
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${mutant.pattern}`, `test/${mutant.file ?? "import-boundaries.test.ts"}`], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
    assert.equal(run.status, 1, `${mutant.name}: must fail behaviorally, output: ${(run.stdout + run.stderr).slice(-2000)}`);
    assert.match(run.stdout + run.stderr, /AssertionError/);
    results.push({ revertedBehavior: mutant.name, passed: 0, failed: 1 });
    process.stdout.write(`proved: ${mutant.name}\n`);
  }
  await writeFile(join(scratch, "index.ts"), original);
  const fixed = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern=class:|export --push isolates|identity export class", "test/import-boundaries.test.ts", "test/network.test.ts"], { cwd: scratch, env: variables, encoding: "utf8", timeout: 600000 });
  assert.equal(fixed.status, 0, (fixed.stdout + fixed.stderr).slice(-3000)); assert.match(fixed.stdout, /tests 7/);
  const report = { sourceSha256: createHash("sha256").update(original).digest("hex"), reverted: results, fixed: { passed: 7, failed: 0 }, reviewedCheckoutMutated: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
