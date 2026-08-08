#!/usr/bin/env node
/**
 * Enforce meaningful docstrings across pm-linear source declarations.
 *
 * The analyzer comes from pm-ops so the fleet shares one lexer-backed policy:
 * every exported declaration, every public member of an exported class, and
 * every substantial private function needs JSDoc that contributes information
 * beyond its identifier. The analyzer has no ignore list and treats unknown
 * declaration forms as violations, so a new syntax form fails closed.
 */

import { join } from "node:path";

import { analyzeDocstringCoverage } from "pm-ops/docstrings";

import { type GateResult, isMainInvocation, runIfMain } from "./script-launcher.ts";

const repoRoot = join(import.meta.dirname, "..");

/**
 * Run the docstring gate against a repository root and return what it would write.
 *
 * Pure by design: it touches neither the process streams nor `process.exit`, so
 * a test imports this and asserts on the returned strings, while the thin
 * {@link main} entry point writes them and sets the exit code.
 *
 * @param root - Absolute repository root to scan.
 * @returns The exit code and the exact stdout/stderr bytes the CLI emits.
 */
export function runGate(root: string): GateResult {
  const report = analyzeDocstringCoverage({ root });
  if (report.violations.length > 0) {
    let message = `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n`;
    for (const violation of report.violations) {
      message += `${violation.file}:${violation.line} ${violation.symbol}: ${violation.reason}\n`;
    }
    return { exitCode: 1, stdout: "", stderr: message.trimEnd() };
  }
  return {
    exitCode: 0,
    stdout: `docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`,
    stderr: "",
  };
}

/**
 * CLI entry point: run the gate and emit its result.
 *
 * Writes the exact stdout/stderr bytes {@link runGate} produced and appends a
 * trailing newline to each non-empty stream so the next `release:check` step
 * starts on its own line rather than butting against this gate's output.
 * {@link runGate}'s returned strings stay newline-free so a test can assert on
 * them exactly. Sets `process.exitCode` rather than calling `process.exit`, so
 * a test can invoke this in-process, observe the streams, and restore the exit
 * code.
 *
 * @param root - Absolute repository root to scan.
 */
export function main(root: string): void {
  const result = runGate(root);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

/** Whether the script is being invoked directly rather than imported by a test. */
export { isMainInvocation } from "./script-launcher.ts";

runIfMain(process.argv, import.meta.url, main, repoRoot);
