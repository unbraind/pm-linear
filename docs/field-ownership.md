# Field ownership review

```ts
import { previewLinearOwnership, LinearOwnershipRefusal, LinearImportRefusal } from "pm-linear";
import type { LinearOwnershipSnapshot } from "pm-linear";

// The caller obtains the explicit tracker root and its reviewed observation.
async function review(pmRoot: string, item: string, acknowledged?: LinearOwnershipSnapshot) {
  try {
    const report = await previewLinearOwnership({ item, base: acknowledged }, pmRoot);
    return { atomicCrossSystem: report.atomicCrossSystem, guarantee: report.guarantee, fields: report.fields, counts: report.counts, observation: report.observation };
  } catch (error: unknown) {
    if (error instanceof LinearOwnershipRefusal || error instanceof LinearImportRefusal) {
      return { code: error.code, field: error.field, remedy: error.remedy };
    }
    throw error;
  }
}
```

Review fields before promoting `report.observation` into an acknowledged
baseline. A previously divergent baseline field stays unknown; the preview
cannot invent a shared value. An identifiable invalid or duplicated field record stays unknown. An unidentifiable corrupt row makes the baseline unknown.
A baseline from another item, provider identity or mapping is foreign. Replayed
older observations are compared against **current SDK reads**, never assumed
unchanged from saved input.

The feature has no write, plan journal, drainer, lease or idempotency key. It
adds no import/export/sync path. Existing SDK import/export mappings are reused
for the observational projection. Local reads copy tracker bytes before SDK
reads can scaffold or repair configuration; owned copies are cleaned in finally.
Provider and tracker are read twice. Neither double reads nor digests promise
an atomic snapshot, protect against ABA changes, or authorize overwrites.

Overlap check: `negotiateLinearSchema` handles metadata drift;
`syncLinearIssues` handles import upserts; `pm-ado` owns revision-tested writes
and field resolution. Core SDK supplies complete-list certification, item
location, persistence canonicalization and runtime status registries. ADO's
`threeWayFieldConflict` is package code, not a missing SDK feature. The preview
keeps these boundaries explicit and does not broaden sync guarantees.

[Public-copy measurements](field-ownership-validation.json) cover 109 real
tracker items. The original unlinked selection refused with zero requests.
A declared one-item synthetic link/provider overlay exercised all eight fields,
disjoint local/provider edits, and one same-field conflict. Its complete receipt
is 2623 JSON bytes on the final SDK projection; every source file hash stayed unchanged during preview.
This validates a public tracker with a synthetic provider, not live Linear.

`pm test pm-linear-field-ownership --run --progress --timeout 600` passed all
seven selected boundary/CLI/isolation tests. The separate prototype-shaped key
regression passed and failed when only its parser fix was reverted. The main
ownership regression also failed with only its classification behavior reverted.
The default 120-second combined linked-test run timed out under host load;
that result was superseded by the explicit-timeout pass, not counted as a pass.
Typecheck, test typecheck, docstrings and whitespace checks passed locally.
No dedicated lint script is configured.

The release suite includes 500 seeded model operation sequences covering native
fields, older observations/provider replays, CRLF/whitespace, relationships,
ambient focus and custom status registries. State is read back through the SDK.
Full serial npm/Bun release gates use the unchanged coverage thresholds. Their
current results and CI status are recorded in the PM item and PR.

An inherited sync issue was independently reproduced and recorded as
[pm-linear-atomic-replay-revision](../.agents/pm/issues/pm-linear-atomic-replay-revision.toon):
the earlier atomic importer could replay a content-only journal after peer edits.
The estimate-provenance work now replaces that importer with the shared forward-only
coordinator. Old pending journals remain audit records; imports do not resume them.
The item remains open for orchestrator verification.


## Re-review round 1: one mapping and complete trust validation

| General rule | Package-wide disposition |
| --- | --- |
| Compare through the write-path mapper | Ownership calls `buildItemPlan`, as every import does. SDK dry-run results expose `prepared` plans from the actual writer preparation; CLI receipts keep their compact counts. SDK operation read-back handles input parsing, status aliases, lifecycle effects and native field storage; export's calendar-date conversion stays confined to export. Absent mapped assignees/deadlines clear through SDK unset options. Empty bodies and tags are applied consistently across aliases. Unchanged fields and status are omitted. |
| Match documented nullable API fields | One issue-field schema supplies import and ownership variants. Cycle names may be null or absent, and optional objects may be omitted. Legacy string-valued workflow types remain accepted by the shared mapper. Unsupported values produce a typed `source_invalid` naming the field. The [Linear cycle schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Cycle) defines `name` as nullable. |
| Validate before trusting any baseline row | All rows are inspected before the authority map is returned. Every occurrence of an invalid or duplicated known field is quarantined, in either order. Unidentifiable corrupt rows make the supplied baseline unknown; the item still produces a review plan. Mapping revision `linear-import-v3-sdk-projection` prevents old-policy observations becoming authority under the corrected mapper. |
| Validate envelopes before dereference | Every HTTP consumer passes through the same transport schema. Null/scalar/array bodies, invalid data/error envelopes and invalid JSON produce sanitized typed refusals. Schema, capture, closure, import, export and validation probes are covered. Field diagnostics use schema-owned paths and never provider values. |

Input-keyed lookup auditing also covered forward/inverse status maps, project
and field maps, Linear identity indexes and export state/label/cycle lookups.
Own-property checks retain prototype-shaped names as ordinary data. Duplicate
current Linear identities are skipped by both import writers, rather than
choosing a target or creating another item. Export team metadata and viewer
probes validate containers before dereference. Shared CLI adapters and the
preflight sentinel preserve source fields and exit code 2 in JSON and TOON.
Both import aliases advertise one shared complete flag definition, so strict
packed CLI parsing reaches the same handlers as direct SDK dispatch.

The unchanged 500-sequence test now compares random provider/local/baseline
triples against **real forward-only dry-run import plans**, using an HTTP fixture for
schema and issue reads and SDK read-back for local state. Provider workflow
names/types, priorities, estimates, nullable/omitted cycles and replayed inputs
vary. No hand-written status mapping or normalization supplies its oracle.

The packed-host test exercises all four review findings in JSON and native TOON
through project-local, npm global, Bun global, npx and bunx consumers in plain
trackers. Focused tests, per-class behavioral revert proofs and full serial
npm/Bun release-gate results are recorded in the PM item and PR.


SDK input normalization also matters before persistence canonicalization. A real
SDK read-back probe found that a plain `none` tag input clears tags, and CSV
splits commas inside a label. Both import writers now encode tag lists through
the SDK's documented JSON-array input, retaining literal control words,
delimiters, quotes and stdin tokens. A 500-sequence producer property compares
those inputs through SDK `parseTags` and `canonicalDocument`; real atomic and
legacy writes read every result back through the SDK. Both creation paths set
parent and scopes explicitly, with focus under each actual writer author used
as an adversarial fixture. Existing updates preserve their relationships.


The full ownership suite passed all 24 tests on SDK 2026.10.23. Its permanent
500-operation model completed with zero failures, using 500 real SDK dry-run
comparisons and SDK state read-backs (737.6 seconds for the model). The suite
also checks 500 generated tag inputs and real updates/creates through both
writers. All twelve isolated behavioral reverts were rejected, including the
offline linked-item filter. Offline aliases count linked terminal items and
exclude unlinked items, with no provider requests and unchanged SDK native
state. Packed acceptance passed all five modes. Full npm/Bun release-gate
status remains separately reported in the PR; interrupted local full attempts
and earlier-head CI successes are excluded.


## Literal provider values and the SDK input boundary

A persistence canonicalizer cannot undo earlier command-input parsing. The shared
forward-only coordinator uses the `linearImportOptions` producer; ownership and
every import entrypoint share `buildItemPlan` and its representability guard.
Imports do not launch a CLI subprocess or place provider strings in argv.

Ownership executes the actual `syncLinearIssues` import coordinator in an
owned disposable copy, scoped through
`runWithActiveExtensions({ path: ownedCopy, noExtensions: true }, ...)`,
then reads that copy back through the SDK. It does not estimate SDK parsing from raw
options. This also observes lifecycle effects such as cancellation clearing
assignments. Legacy inputs retain a copy-only force option for native authorization checks;
unchanged statuses are still omitted. The shared coordinator pairs every target
with an SDK revision and does not replay copied journals. A copied SDK policy or
lease refusal stops that projection. A successful projection never authorizes a real write. The source
view is compared again before it contributes any hashes, and no staged
metadata, history or hooks reach the source tracker or provider.

Import and ownership queries share one selection of every consumed issue field,
including immutable team identity and all estimate-scale flags. The coordinator
uses the same unit-aware or legacy input mapping as apply, preserving the existing
same-team conversion table, including stale tables. An unchanged imported issue
therefore has equal local/provider hashes, and acknowledging that observation
then replaying it reports every field as `unchanged`. The projection mapping
revision changed; older observations must be reviewed and acknowledged again.

The pinned SDK still interprets body/description `-` as stdin and assignment
`none`/`null` as clear controls. Its public mutation options have no literal
switch. Internal stdin-marker helpers are not imported. Until
[pm-cli#1614](https://github.com/unbraind/pm-cli/issues/1614) supplies a supported
literal path, these values produce typed `LinearImportRefusal` with
`code: "unrepresentable_value"`, a native `field`, a remedy and exit code 2.
Whitespace/case variants of controls refuse too. Empty native titles and
non-calendar/relative deadline values also refuse before writes. A nullable or
empty provider assignment clears the imported assignment through the SDK unset
option. Local historical data is read and exported normally.

No caller stdin is consumed. The complete selected batch is checked before
its first item write, including the deprecated SDK atomic-name compatibility entrypoint. JSON and native TOON
retain the code and field through both import aliases and ownership commands.
Body strings such as `none`, `null`, `@file`, `--` and `--force`, and leading-dash
titles, remain literal. Labels use the SDK JSON-array input. Captured comments
use structured SDK JSON notes; export sends typed JSON GraphQL variables.

The additional seeded test performs 500 real imports across legacy and unit-aware inputs,
reads every result back through the SDK, checks accepted literal bytes and
relationships, and compares acknowledged ownership observations with stored
state. It also mixes typed refusals with the writes, and a subprocess test
verifies that piped caller input remains untouched after safe and refused
imports. The literal SDK adoption follow-up is `pm-linear-literal-sdk-values`.

The earlier 500-operation reference model also applies real dry-run rows in a
separate owned reference tracker and reads the resulting native document
through the SDK. It no longer merges raw option values into a canonical
document as its oracle. Permissions are bypassed only in that reference copy;
field effects still come from the SDK coordinator. Deadline hashes now use
native SDK timestamps on both sides, so a local time change cannot be hidden
by export-only calendar-date conversion.

Earlier literal-boundary validation on SDK 2026.10.24 passed project-local, npm global,
Bun global, npx and bunx acceptance. Each mode made 123 read requests,
returned a 3302-byte host JSON receipt, and passed 28 literal-value plus
14 malformed-source dispatch checks across JSON and TOON. The public-copy
run measured six reads and one same-field conflict across eight fields;
both the immutable source and derived tracker stayed unchanged during previews.

Ownership now projects the shared forward-only coordinator for every input shape.
It does not execute an atomic compatibility override or rollback journal in its
isolated copy. Mapping revision v5 requires a fresh acknowledgement. Completed
status replays omit the unchanged status field, matching production imports.


## Projection outcomes and simulation receipts

The isolated writer's outcome is part of the ownership contract. A skipped,
unconfirmed, missing or error-bearing target refuses the observation with typed
`projection_failed` and a retry remedy. Reading the old item after a refused
write does not establish a provider projection. The source lease stays owned by
its peer; retry after it is released computes the actual provider edit.

All live dry-run routes retain `dryRun: true`, including empty pages and filtered
batches. CLI summaries label counts as hypothetical. JSON and TOON dispatch the
same result, and the simulation leaves item/history data unchanged. Seeded
reference writers use the SDK status normalizer and registry lifecycle roles;
raw provider aliases never decide whether a native transition repeats.


Read-only source files are supported. The guarded copy makes its own regular
files and directories writable before invoking SDK producers, so native history
appends work there. Symbolic links are never chmod targets. Source bytes and
permissions remain unchanged; copied filesystem permissions do not attest native
authorization. The public-copy validation separately checks those invariants.


The [current read-only public-copy receipt](ownership-forward-validation.json)
measures 112 original items and a declared one-item synthetic link overlay.
Six read requests exercise eight fields, one disjoint edit pair and one
same-field conflict. Original and derived preview bytes and permissions stay
unchanged. The provider is a synthetic HTTP fixture; no live Linear service is
validated by this receipt.
