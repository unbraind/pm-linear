# Focused provider dependency closure

Tracking: [pm-linear-focused-closure](../.agents/pm/features/pm-linear-focused-closure.toon).

The overlap check used the current core SDK dependency/provenance APIs,
pm-graph's offline analysis and blocker cuts, and pm-context's neighborhood
packing. These consume relationships already present. This command acquires only
Linear-specific prerequisite context for explicit linked local selections. It
adds no graph analytics, imports, exports, sync writers or apply/recovery plans.
Existing import/export/sync behavior is outside this change's runtime scope.

The wire selection follows Linear's published [GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql):
`Issue.inverseRelations` contains incoming relation nodes, `IssueRelation.issue`
is the source and `relatedIssue` is the target. Only `type: blocks` adds a
prerequisite. Related, duplicate and other relation types do not. Archived
relations are included conservatively. Incoming pages cannot accept filtering
by relation type, so non-blocking rows consume the relation budget too.

The provider schema, SDK options and emitted receipt share one strict schema
interpreter. Arrays must be dense, integers finite and in range, objects must
have the declared fields, and strings/arrays/transport/output have explicit
bounds. Malformed or source-changing responses refuse the entire preview.
Access and cap boundaries retain the known frontier without declaring it complete.

`test/dependency-closure.test.ts` covers the exact three-hop frontier; SDK and
registered-command parity in JSON/default output modes; imported membership;
cycles; cap exhaustion; inaccessible blockers; HTTP authorization, rate-limit,
server, malformed-body and oversized-body failures; paging identity/direction,
duplicates and cursor drift; extreme options and sparse arrays; byte-identical
source state; concurrent independent readers; and competing local transitions
injected at every HTTP step boundary of a four-request acquisition.

The seeded model uses 500 random operation sequences with edits and older graph
replays, whitespace/CRLF variants and cycles. The reachability oracle is a simple
set model. Native state is seeded through the real SDK, including provenance,
body, priority, tags, deadline, assignee and a blocked_by relationship. Random
custom registry names/roles are registered through the SDK. State read back
through the SDK must remain identical after every preview. There is no
hand-written normalization oracle or content-only idempotency key. No feature
write exists to journal, replay or lease; each request budget is invocation-local
and cleanup removes only the mirror that invocation created.

The SDK's high-level reads can write usage feedback and caches even when the
application only requests reads. The mirror isolates those writes while retaining
`listAllComplete` and `certifyCompleteListResult`, SDK identity lookup and SDK
schema/type discovery. A bounded physical bootstrap copy precedes every settings
read. It has no item-folder filter. SDK enumeration supplies membership and
`locateItem` supplies each exact file copied into the final read view, alongside
settings and schema. The second certified read must equal the first. Thus stale
or unrelated physical files cannot become package-invented membership. The
source is re-read after provider acquisition and changed local state refuses.
Transient changes reverted between observations, or provider changes across
independent issue reads, cannot be ruled out without a provider snapshot API.

Public tracker validation and measured results are recorded in
[dependency-closure-validation.json](dependency-closure-validation.json).
The reproducible validator uses only a disposable public tracker copy and a
synthetic local HTTP responder; no hosted tracker or Linear account is involved.

## Public corpus measurement

Snapshot: `unbraind/pm-linear` main `b437db2`, 107 public items, no Git
metadata. The unmodified read-only copy contains zero Linear links; selecting
one of its existing items refuses before network access (0 HTTP requests).
A separate derived copy adds exactly one synthetic Linear provenance marker
through the SDK before being frozen read-only. It retains 107 public items and
acquires 4 fixture issues / 3 prerequisite relations / 3 missing blockers in
4 HTTP requests, emitting 789 JSON bytes. Both copies retain identical file-name
and byte hashes after validation. No live Linear account was tested.

Reproduce by archiving `.agents/pm` at that revision into two temporary
non-git directories. In the derived copy only, use `PmClient.update` to set one
existing item's description to `buildProvenance({id:"a",identifier:"FIXTURE-a"})`.
Mark both copies read-only, then run:

```sh
node test/dependency-closure-validation.ts "$public_tracker" "$derived_tracker"
```

The validator refuses writable copies and paths outside the system temporary
directory. It removes Git from PATH and sets a Git discovery ceiling. The
reported JSON contains counts and hashes only, with no local topology or data.

## Regression revert

Disabling only the recursive `enqueue(blocker, current.depth + 1)` operation in
`fetchLinearDependencyClosure` causes the exact three-hop test to fail. Restoring
that operation restores the six focused examples. The model test is also part of
the unchanged CI release gates; full gates are deliberately delegated to CI to
avoid saturating the shared host.

## Review classes closed

The source receives only filesystem reads and the SDK's observational root
resolver. Every settings, schema, initialization, complete-list and identity
lookup call runs on owned isolated paths. Missing settings are materialized from
SDK defaults only in the bootstrap copy. Missing optional schemas may be
backfilled there without reaching the original. Tree hashes include directory
names, file names, modes and bytes, so creation of an absent file or an empty
runtime/history directory cannot escape the regression.

Source isolation is tested in 24 SDK/JSON/default-TOON previews across missing
statuses, empty history, missing settings and missing all schema; each state is
also tested with all source modes read-only. Every result succeeds and every
source tree hash remains equal. Tests restore test-owned modes in finally.

Membership tests use real SDK-created custom top-level and nested folders,
then SDK moves between Task, Custom, Nested and Task. The imported blocker
remains imported and selectable in each layout. No root-component comparison
or package-defined item-folder enumeration decides membership.

| Root call site | Resolution contract |
| --- | --- |
| `fetchLinearDependencyClosure` | Capture caller cwd before awaiting; call `resolvePmRoot(callerCwd, pmRoot)` once, then canonicalize with `realpath`. |
| `readClosureItems` | Receives that absolute canonical source; SDK calls receive only absolute bootstrap/reader paths. |
| SDK-located item copy | Use the SDK's absolute item path; bound its relative suffix to the isolated bootstrap, then join it under the absolute reader. |
| Scratch paths | `tmpdir` plus fixed child names; no user-relative root is re-resolved. |
| Public-copy validator | Resolve each operand once against caller cwd; census reads run in an owned copy. |
| Existing thread capture | Its existing `resolvePmRoot(process.cwd(), pmRoot)` call resolves once; unchanged by this patch. |

A seeded 32-case path property checks absolute, relative, dot, dot-prefix,
trailing-slash and symlinked roots. It includes a different caller cwd and two
consecutive directories both named tracker, exercising the doubled-relative-root
failure. All cases must equal one canonical SDK result and retain source hashes;
the eight base variants also run through the registered CLI handler.
