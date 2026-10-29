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
with the owned namespaces are escaped reversibly; earlier foreign labels still export.

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

Unit-aware imports use one native create/update mutation per item. They preserve
unmapped native effort, annotations and relationships, explicitly state all five
scope fields, clear absent assignees/deadlines, and use the SDK status registry to
determine terminal status. Native SDK persistence owns whitespace normalization.

Before reading provider input, the importer observes linked item history through
the SDK. A revision includes the monotonically growing history length and document
snapshot. Each inspect/retry/recovery and immediately-before-write check re-reads
that revision; a changed target is skipped, including content-restoring ABA edits.
No second dependent mutation can run for a skipped item. Deterministic IDs occupied
by foreign items are skipped. Bounded `estimateSkips` receipts identify `foreign`
or `superseded` targets, with an explicit omission count. A stored success from a peer is reconciled with the
current SDK state instead of reported as a new write.

`--atomic` coordinates unit-aware items with `commitWorkspaceTransaction`; it does
**not** exclude ordinary SDK/CLI writers (pm-cli#1620). There remains a window
between the final SDK read and SDK write because the mutation API has no expected
history revision option. The feature does not claim serializable isolation.
Transaction identity includes target revisions as well as desired content, so an
older replay after a later import cannot reuse a completed content-only journal.
Current target state decides unchanged outcomes. Preview uses the same entry
producer and step inspection as apply, without committing.

Compensation re-reads before restoring an existing item's native history version.
It deletes a newly created item only when this invocation verified its complete SDK producer receipt and planned body
against native history and retained the exact history coordinate, and no later write
exists. It never constructs that proof from a subsequently observed record.
Per-invocation write nonces distinguish a peer's identical success from this
invocation's ownership. After process recovery, unavailable ownership proof means leaving the target in
place; audit and successful writes remain intact. Restore/delete operations also
have the SDK read-to-write window. Retry always builds a fresh revision-bound plan.

The older provider-less atomic path is unchanged; the existing
`pm-linear-atomic-replay-revision` item tracks that separate migration. Unit-aware
imports do not call that frozen-plan path.
