/**
 * Behavioral coverage for the docstring gate script.
 *
 * The gate is a release gate, so a test must assert both the clean path (the
 * real repository passes) and the violation path (an undocumented declaration is
 * reported), plus the CLI entry points that write streams and set the exit code.
 * Every assertion runs against {@link runGate}'s returned strings or captured
 * process streams, never against the analyzer directly, so a regression in the
 * gate's own wiring surfaces here rather than only at release time.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isMainInvocation, main, runGate } from "../scripts/docstring-gate.ts";
import { runIfMain } from "../scripts/script-launcher.ts";

test("docstring gate runGate returns success for the real repository root", () => {
  const root = resolve(import.meta.dirname, "..");
  const result = runGate(root);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /docstring-gate:.*file\(s\).*documented/);
  assert.equal(result.stderr, "");
});

test("docstring gate runGate reports violations for an undocumented source", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-linear-docstring-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function undocumented(): void {}\n");
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /undocumented: no docstring/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate main writes violations to stderr and sets the exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-linear-docstring-main-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function undocumented(): void {}\n");
    const originalExitCode = process.exitCode;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stdout = "";
    let stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    process.exitCode = undefined;
    let observedExitCode: number | string | undefined;
    try {
      main(root);
    } finally {
      observedExitCode = process.exitCode;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }
    assert.equal(observedExitCode, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /undocumented: no docstring/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate isMainInvocation resolves matching and non-matching scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-linear-docstring-main-invocation-"));
  try {
    const script = join(root, "docstring-gate.ts");
    const other = join(root, "other.ts");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;
    assert.equal(isMainInvocation([process.execPath, script], url), true);
    assert.equal(isMainInvocation([process.execPath, other], url), false);
    assert.equal(isMainInvocation([process.execPath], url), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIfMain forwards arguments only when the module is invoked directly", () => {
  // runIfMain replaces the per-script array-index dispatch. The main branch
  // invokes run with the forwarded arguments; the import branch does not, so
  // `run` is covered by the tests that call it directly.
  const root = mkdtempSync(join(tmpdir(), "pm-linear-runifmain-"));
  try {
    const script = join(root, "launcher.ts");
    const other = join(root, "other.ts");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;
    const received: number[] = [];
    runIfMain([process.execPath, script], url, (value: number) => { received.push(value); }, 7);
    assert.deepEqual(received, [7]);
    runIfMain([process.execPath, other], url, (value: number) => { received.push(value); }, 9);
    assert.deepEqual(received, [7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate main writes a success line to stdout and exits 0", () => {
  // The real repository is fully documented, so main() takes the success path:
  // non-empty stdout is terminated with a newline and exitCode stays 0. This
  // covers the stdout-newline branch the violation-only main test cannot.
  const root = resolve(import.meta.dirname, "..");
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  let observedExitCode: number | string | undefined;
  try {
    main(root);
  } finally {
    observedExitCode = process.exitCode;
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
  }
  assert.equal(observedExitCode, 0);
  assert.match(stdout, /docstring-gate:.*documented\.\n$/);
});
