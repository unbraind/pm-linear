# Linear estimate provenance

An estimate is a provider-native point value. Linear teams can configure different
scales, including zero and extended values ([provider documentation](https://linear.app/docs/estimates)).
The unit contract belongs to pm-linear; core `estimated_minutes` and Gantt duration
inputs cannot infer Linear team semantics.

## Example and typed SDK surface

```ts
import {
  linearEstimateScaleRevision, inspectLinearEstimates, syncLinearIssues,
  type LinearEstimateTeam, type LinearEstimateMapping,
} from "pm-linear";

const team: LinearEstimateTeam = {
  id: "team-eng", key: "ENG", issueEstimationType: "fibonacci",
  issueEstimationAllowZero: false, issueEstimationExtended: false,
};
const conversion: LinearEstimateMapping = {
  teamId: team.id, scaleRevision: linearEstimateScaleRevision(team),
  entries: [{ points: 5, minutes: 240 }],
};
// Save team as reviewed-team.json and conversion as conversion.json if using CLI.
await syncLinearIssues({ team: "ENG", limit: 100, estimateMapping: conversion }, tracker);
const report = await inspectLinearEstimates({ team, limit: 20 }, tracker);
// report.rows: [{ id, points: 5, minutes: 240, state: "converted", scaleRevision }]
```

The SDK uses its existing lazy host loader. Merely importing the module does not
load a host SDK or inspect process executable/symlink locations. All command and
import aliases use the same producer and writer, including `linear-sync import`.
Export round-trips native points and never sends the opaque provenance tag as a
Linear label. Existing provider-less `estimate:<n>` tags still read and export.

The CLI requires an explicit `--team` for inspection. With `--scale`, it uses a
reviewed snapshot offline. Otherwise it reads current team settings from Linear.
The snapshot's `key` must agree with `--team`; immutable team IDs bind conversions.
The scale revision covers the team ID, scale type and both boolean settings. A team
key rename alone does not invalidate estimates. Unknown future scale names remain
native data rather than being guessed into a duration.

`--estimate-mapping` accepts the closed JSON shape shown above on `linear sync`,
`linear import` and `linear-sync import`. A supplied mapping must match every
selected issue's team and current scale revision before any item write. Subsequent
imports preserve the previous same-team mapping. If that mapping becomes stale,
it remains evidence and yields no minutes until explicitly replaced. Moving an
issue to a different team drops that team's old mapping. An explicit zero remains
zero; an unestimated issue remains null and never becomes a default point or time.

## Boundary and receipt contract

Team objects accept only the five example keys. IDs are 1..128 letters, numbers,
underscores or dashes; keys start with an uppercase letter. Scale names have 1..64
characters. Mapping objects accept only `teamId`, a 64-character lowercase SHA-256
`scaleRevision`, and a dense `entries` array of at most 64 unique point values.
Points are finite numbers in 0..1000000. Minutes are integers in 0..175200. There
is no ratio, multiplication, interpolation, rounding or count-derived float decision.
Operator JSON files must be regular files of at most 16384 bytes. Each import tag
is a canonical lowercase hexadecimal encoding because native tag normalization
folds letter case. Producer and reader share the same schema and codec. Provider labels that collide
with the owned namespaces, including `estimate:` and `cycle:`, are escaped as
versioned records bound to the Linear issue ID. Earlier foreign and malformed
literal tags still export unchanged. The same schema and derived UTF-8/JSON
bounds validate every produced literal label record.

`inspectLinearEstimates` returns `ok`, `teamId`, `scaleRevision`, complete corpus
`counts`, at most `limit` rows, `omitted`, and `writes: 0`. Rows expose only item ID,
points, nullable minutes, state and recorded scale revision. All emitted numeric
values are validated before success. Missing provenance is counted as `legacy`;
a malformed or ambiguous contract affects only that item (`invalid`), and records
without a matching Linear provenance link/native point value are never trusted.
Inspection isolates tracker bytes before invoking repairing SDK read paths, so
read-only source snapshots are supported.

Typed `LinearEstimateRefusal` categories include `estimate_input_invalid`,
`estimate_scope_mismatch`, `estimate_scale_unavailable`, `estimate_local_unavailable`
and `estimate_target_changed`. Each includes `field`, `remedy` and usage exit code
2; CLI JSON/TOON preserve the category and remediation. Invalid inputs are refused
before mutations, and operator file names are not included in diagnostics.

## Replay, ownership and concurrency

All payload families use one native create/update mutation per item. They preserve
unmapped native effort, annotations and relationships, explicitly state all five
scope fields, clear absent assignees/deadlines, and use the SDK status registry to
determine terminal status. Native SDK persistence owns whitespace normalization.

Before reading provider input, the importer observes linked item history through
the SDK. A revision includes the monotonically growing history length and document
snapshot. Each inspect/retry/recovery and immediately-before-write check re-reads
that revision; a changed target is skipped, including content-restoring ABA edits.
The planning image must match the revision's document through the SDK's own
canonicalizer. A peer edit during corpus or revision acquisition leaves that
target unpaired and skipped; missing observations never adopt a newer revision.
Independent targets continue, and a fresh retry reads the peer's conversion.
No second dependent mutation can run for a skipped item. Deterministic IDs occupied
by foreign items are skipped. Bounded `estimateSkips` receipts identify `foreign`
or `superseded` targets, with an explicit omission count. A stored success from a peer is reconciled with the
current SDK state instead of reported as a new write.

All imports use the same forward-only per-item coordinator, including provider-less
inputs. Explicit `--atomic` requests refuse before import work unless `--forward-only` accepts migration. No live-tracker import uses workspace or item batch transactions, restores,
deletes, compensations or history ownership proofs. Native SDK preview executes
only in an owned guarded mirror; runtime-only host SDK links are omitted without
following them before the SDK regular-data preview runs. Each target's complete `importResults` receipt names its action and any
`import_conflict`, `import_failed`, `import_incomplete` or `import_observer_failed` outcome with a remedy.
A failure in B retains A's completed write. After-write observer failures report
A as applied, never skipped. Native ordering/hierarchy relationships determine
prerequisites using the SDK graph ontology; skipped prerequisites skip dependents.

Updates omit unchanged fields and status, including repeat closure. The target
SDK registry identifies primary close/cancel roles; their native assignee-release
effect remains stable across replays. Reference models derive the terminal state
through SDK lifecycle producers instead of handwritten normalization. Immediately
before the native mutation, the paired SDK revision is re-read. A stale base skips
all dependent mutations. SDK one-item preview validates updates that route through
close before live fields can be saved. Preview and ownership execute this same
coordinator in an isolated copy. A fresh retry always reads current state; there
are no content-keyed committed journals or frozen recovery plans.

The final SDK read-to-write window remains because the SDK has no item precondition
(pm-cli#1576), and workspace transactions do not exclude ordinary writers
(pm-cli#1620). SDK close can internally save fields separately from closure; isolated
validation does not remove failures or peer races inside the final native call.
No cross-item rollback, serializable isolation or arbitrary-I/O atomicity is claimed.

Deleted identities remain reserved and skip alone, regardless of an old rollback
message. Historical items and histories still read and export. An operator can
explicitly restore an intended historical item through the SDK, then retry; the
importer never restores a deleted item implicitly. New forward-only failures
produce no tombstones, so a retry recognizes completed items and applies only
remaining differences. The declared host minimum remains 2026.10.24 in npm and the
manifest, with its development SDK pin unchanged. Packed acceptance covers that
minimum and current host in all five supported installation layouts.

`linear ownership` acquires the same complete issue fields as import, then runs
the production import coordinator in an isolated copy. It retains the item's
declared conversion table and chooses the same unit-aware writer. After importing
an unchanged issue, its acknowledged ownership observation replays as
`unchanged`, including the provenance tags. Both JSON and TOON use this SDK path;
old ownership mapping revisions require a fresh acknowledgement.

The [packed receipt](estimate-packed-validation.json) records minimum/current host
versions across project-local, npm-global, Bun-global, npx and bunx layouts, exact
command and peer-interleaving counts, retained/retried identities, read-only
provider requests and compact JSON sizes. The separate
[artifact receipt](estimate-artifact-validation.json) binds its SHA-256 to every
current shipped file and records the isolated ignored-file mutation check.

[Forward-import reverts](forward-import-revert.json) cover repeat closure,
rollback reintroduction, prerequisite skips, revision fences and installed SDK
code pointers. [Recovery reverts](estimate-recovery-revert.json) retain nine
current-contract native-history/identity/mapping/host cases, with fixed source
passing eight tests. Snapshot and ownership parity receipts retain their
respective two and three behavioral mutants. These are disposable-copy tests;
no reviewed checkout was mutated.

The former provider-less atomic path has also migrated to this coordinator. The
existing `pm-linear-atomic-replay-revision` item retains its audit context; production
imports no longer resume those journals. Old pure atomic-named SDK helpers remain
source-compatible descriptive helpers only. `importLinearForwardOnly` is the prepared-row writer. Deprecated `importLinearAtomic` refuses with typed `atomic_unavailable` before reads or writes unless `forwardOnly: true` explicitly accepts per-item application. `SyncOptions.atomic: true` requires the same consent. Receipt IDs never resume a journal; the obsolete batch-commit seam remains inert.

A native-call exception triggers SDK readback. Complete current desired fields
are reconciled as unchanged without attributing a new write (`import_reconciled`);
unchanged targets are skipped. A changed target whose
complete desired fields cannot be confirmed is `unconfirmed`/`import_incomplete`,
with an explicit count and inspection remedy; dependent writes skip. This avoids
misreporting partial native calls or peer changes as untouched targets.


SDK sync responses preserve the complete fetched `issues` array, in provider
order and before local filters. Native write outcomes remain separate in
`LinearImportReceipt`; prepared-row imports fetch no provider issues. CLI
receipts deliberately omit raw payloads. All payload families clear missing,
null or suppressed assignment inputs through SDK unset; legacy inputs have no
assignment-preservation exception.

The shared native writer quarantines duplicate provider IDs in both stored provenance and incoming batches before selecting targets. Every failed, conflicted or unconfirmed row produces nonzero `exit_code` across SDK, sync and both importer aliases; ordinary filters and complete readback reconciliation remain successful.
