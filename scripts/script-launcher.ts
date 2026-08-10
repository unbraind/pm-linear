/**
 * Shared launcher detection and contracts for operational scripts.
 *
 * Every script that guards its top-level execution behind an "am I the main
 * module?" check uses {@link isMainInvocation}, and every script that runs only
 * when direct-invoked does so through {@link runIfMain}, so the symlink-aware
 * comparison and the guarded dispatch are each defined once rather than copied
 * across scripts. The {@link GateResult} contract lives here too, so the gate
 * scripts share one declaration instead of drifting two copies. A script
 * re-exports {@link isMainInvocation} so its own test can exercise the guard
 * without reaching into this shared module directly.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the script is being invoked directly rather than imported by a test.
 *
 * Compares resolved real filesystem paths on both sides. `import.meta.url` is
 * already symlink-resolved as a URL, but on Windows `realpathSync(argv[1])` can
 * return a different drive-letter casing than the URL form, so an exact href
 * comparison would treat a direct invocation as a library import and silently
 * skip `main`. Resolving both sides through `realpathSync` after converting the
 * URL back to a path removes that casing and symlink ambiguity.
 *
 * An unresolvable path **propagates** rather than returning false. The two
 * outcomes are not equally safe: returning false makes the caller treat the
 * script as a library import and skip `main`, so a required release check
 * exits 0 having done nothing — the one failure these gates exist to prevent.
 * Letting `realpathSync` throw turns that into a loud non-zero exit. Either
 * path failing to resolve after Node has already loaded the module means the
 * environment is broken, and a broken environment must not silently satisfy a
 * gate.
 *
 * A genuinely different entry path still returns false, which is how a test
 * importing a script declines to run it.
 *
 * @param argv - The process argv slice to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` resolves to this module's own real path, false
 *          when it resolves to a different one.
 * @throws Whatever `realpathSync` throws when either path cannot be resolved.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

/**
 * Runs `run` with the supplied arguments only when the module is direct-invoked.
 *
 * Replaces the per-script `[noop, main][Number(isMainInvocation(...))](...)`
 * array dispatch: that construct shipped a dead arrow in every script purely to
 * give the coverage gate a second function to count, and a copy of the dispatch
 * lived in three files. This one helper forwards the arguments when the module
 * is main and does nothing under test import, leaving `run` itself to be covered
 * by the tests that import and call it directly.
 *
 * @param argv - The process argv slice, as received at module top level.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @param run - The main entry point to invoke when direct-invoked.
 * @param runArguments - Arguments to forward to `run` when it is invoked.
 */
export function runIfMain<T extends readonly unknown[]>(
  argv: readonly string[],
  moduleUrl: string,
  run: (...runArguments: T) => void,
  ...runArguments: T
): void {
  if (isMainInvocation(argv, moduleUrl)) run(...runArguments);
}

/**
 * Outcome of one gate run, held as plain strings so a test can inspect it.
 *
 * Shared by every gate script so the contract is declared once: two copies of
 * one interface drift independently, and the duplication gate runs at a 0%
 * threshold, so a later edit that grows either copy can also fail that gate.
 */
export interface GateResult {
  /** Process exit code the run would produce (0 on success; non-zero on failure). */
  readonly exitCode: number;
  /** Bytes the run would write to stdout. */
  readonly stdout: string;
  /** Bytes the run would write to stderr. */
  readonly stderr: string;
}
