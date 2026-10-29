# SDK adoption audit disposition, 2026-10-25

The supplied fleet audit's `pm-linear` / `Unused pm SDK capabilities` section
establishes **no additional equivalent replacement**. This follow-up verifies
that disposition against main revision `fcfdf190d1178eb5842b00affade13caeddf82b9`.
It adds audit documentation, differential verification tooling and tracker
evidence. There are zero runtime
replacements, zero deleted runtime lines, and no intentional behavior changes.

Tracking: [pm-linear-292r](../.agents/pm/chores/pm-linear-292r.toon), related to
[prior SDK adoption](../.agents/pm/features/pm-linear-du0a.toon).

| Audit observation | Current implementation | Disposition and evidence |
| --- | --- | --- |
| Complete reads already delegate to `listAllComplete` (audit: `index.ts:1188-1196`) | `readPmItems`, `index.ts:1188-1203`, calls `listAllComplete({ includeBody: true }, { pmRoot, noExtensions: true })` and `certifyPmItems` | Already adopted; retain SDK certification and the additional consumed-field checks. See `test/complete-local-reads.test.ts` and [existing acceptance and revert evidence](complete-local-reads.md). |
| Schema discovery already uses `schemaList` (audit: `index.ts:1307`) | `readSchemaStatuses`, `index.ts:1307-1315`, calls SDK `schemaList` | Already adopted; retain local registry discovery. See `test/schema-drift.test.ts` and [schema negotiation evidence](schema-negotiation.md). |
| Atomic imports already use `commitItemMutations` | `importLinearAtomic`, `index.ts:2115-2212`, delegates the complete plan to the SDK transaction helper | Already adopted; retain SDK journaling and compensation. See `test/atomic.test.ts`. |
| Standalone import loader is not an unused SDK feature | `importRuntimeSdk`, `index.ts:1125-1130` | Retain the compatibility boundary as explicitly directed by the audit. The missing-SDK control is in `test/complete-local-reads.test.ts`. |
| Existing close-reason defect is package work | [pm-linear-uhu6](../.agents/pm/issues/pm-linear-uhu6.toon) | Separate existing issue; no upstream SDK gap was established by this audit. |

No finding is deferred for a missing SDK export. This disposition applies to the
specified audit observations, rather than certifying every package code path.

## Differential verification

Build `origin/main` independently from archived `index.ts`, `tsconfig.json`, and
`package.json`, using the unchanged installed dependency graph. Compare that
module with the candidate's `dist/index.js` through the real SDK extension test
harness. The built runtime modules are byte-identical. The repeatable comparison
is [test/sdk-adoption-differential.ts](../test/sdk-adoption-differential.ts):

```sh
node test/sdk-adoption-differential.ts "$baseline_module" "$linear_snapshot" "$graph_snapshot"
```

The operands are the independently built main module and read-only scratch
tracker roots. The script refuses writable snapshots or trackers outside the
system temporary directory. Do not pass original trackers.

To prepare the baseline and one snapshot from this checkout:

```sh
scratch=$(mktemp -d)
mkdir "$scratch/baseline" "$scratch/linear"
git archive fcfdf190d1178eb5842b00affade13caeddf82b9 index.ts tsconfig.json package.json |
  tar -x -C "$scratch/baseline"
ln -s "$PWD/node_modules" "$scratch/baseline/node_modules"
node_modules/.bin/tsc --project "$scratch/baseline/tsconfig.json"
git archive fcfdf190d1178eb5842b00affade13caeddf82b9 .agents/pm |
  tar -x -C "$scratch/linear"
chmod -R a-w "$scratch/linear"
npm run build
node test/sdk-adoption-differential.ts \
  "$scratch/baseline/dist/index.js" "$scratch/linear/.agents/pm"
```

For the second public tracker, archive `.agents/pm` from the pm-graph revision
below into a separate scratch directory, mark that copy read-only, and pass
its tracker root as one more operand. Dependency pins remain unchanged.

The observed input snapshots are committed public trackers archived without
git metadata:

| Tracker | Snapshot revision | Items |
| --- | --- | ---: |
| pm-linear | `fcfdf190d1178eb5842b00affade13caeddf82b9` | 106 |
| pm-graph | `3f02532745c2ad6f718788db1e3d13b62c2ceac1` | 106 |

For each snapshot, mark all files read-only and directories non-writable. Set
`GIT_CEILING_DIRECTORIES` and empty `PATH` before running either module. Compare
these three full structured results with `assert.deepEqual`:

1. `createExtensionTestHarness(extension, ...).runExporter` for the `linear`
   exporter with empty options and JSON output, exercising certified complete
   corpus reads and full payload construction.
2. `negotiateLinearSchema({ team: "AUDIT" }, pmRoot)`, using a local HTTP server
   with synthetic complete team metadata and an artificial API key. The real
   SDK reads the copied tracker status registry.
3. `syncLinearIssues({ team: "AUDIT", limit: 1, atomic: true, dryRun: true },
   pmRoot, { fetchIssues })`, supplying one synthetic unstarted issue through
   the existing provider-fetch seam. Local corpus reading remains the real SDK
   path; the result plans one create and zero updates without committing it.

Result: **6/6 comparisons identical**, 212 public items exported per build,
four read-only HTTP requests, and zero intentional differences. Hash every
snapshot file name and byte before and after each module invocation; both
snapshots remained unchanged, including the absence of new runtime files.
No live Linear account or hosted tracker was accessed.

The invocation above records the API used by this dated audit. Current reruns
must explicitly migrate an atomic request with `forwardOnly: true`, or select
`forwardOnly: true` without `atomic`; an unavailable atomic request now refuses
before reads or writes. The original audit results remain historical evidence.

## Verification boundaries

Revert proofs per replacement are not applicable: this follow-up replaces no
function. Earlier complete-read revert evidence remains linked above; it is
historical evidence, not a newly executed revert test.

No history-verification path, cached event index, cursor decision, local writer,
or non-idempotent remote call changes. Consequently this documentation change
does not claim fresh cache-corruption, concurrent-close, crash-boundary, or
remote-idempotency verification. The read-only differential cannot establish
those properties.

Run the unchanged package gates:

```sh
npm run typecheck
npm run docstring
node --test test/atomic.test.ts test/schema-drift.test.ts test/complete-local-reads.test.ts
npm run release:check
bun run release:check
```

The package has no lint script; type checking and the documented-source gate
(`npm run docstring`) are run separately. Preserve the existing coverage thresholds (99% lines,
96% branches, 100% functions); the separate 100% coverage task remains
[pm-linear-xw01](../.agents/pm/tasks/pm-linear-xw01.toon).

Observed local results: targeted tests **118/118**, npm release gate **363/363**,
Bun release gate **363/363**, zero failures or skips. Both release gates measured
**99.71% lines / 97.22% branches / 100% functions** over the configured runtime
source, meeting the existing thresholds. Both ran with a clean home and isolated
git configuration. Typecheck, `build:test` and docstring checks pass as well.

Strict local tracker health with extensions enabled reports managed pm-github
host-version skew, already tracked by
[pm-linear-bzam](../.agents/pm/issues/pm-linear-bzam.toon). Core health with
`--no-extensions` passes with the existing advisory historical-provenance
warning tracked by [pm-linear-jloc](../.agents/pm/issues/pm-linear-jloc.toon).
These health observations are separate from the package release gates; no
history repair or dependency change is part of this follow-up.

Current import contract update: the historical atomic-import row above is superseded
by [forward-only imports](../README.md#forward-only-imports). Production imports no
longer invoke SDK batch transactions or compensation; one-item SDK preview remains
used for lifecycle validation. The development SDK pin is unchanged.
