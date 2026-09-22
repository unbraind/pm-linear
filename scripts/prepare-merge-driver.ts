/**
 * npm `prepare` hook that installs pm's field-aware Git merge drivers.
 *
 * Git never clones `.git/config`, so every clone must register the drivers that
 * `.gitattributes` declares. The canonical implementation lives in
 * `pm-ops/merge-driver`; this file stays a thin launcher over it.
 */
import { runPrepareMergeDriver } from "pm-ops/merge-driver";

process.exitCode = runPrepareMergeDriver();
