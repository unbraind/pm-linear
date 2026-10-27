# Field ownership review

```ts
import { previewLinearOwnership, LinearOwnershipRefusal } from "pm-linear";
import type { LinearOwnershipSnapshot } from "pm-linear";

// The caller obtains the explicit tracker root and its reviewed observation.
async function review(pmRoot: string, item: string, acknowledged?: LinearOwnershipSnapshot) {
  try {
    const report = await previewLinearOwnership({ item, base: acknowledged }, pmRoot);
    return { fields: report.fields, counts: report.counts, observation: report.observation };
  } catch (error: unknown) {
    if (error instanceof LinearOwnershipRefusal) return { code: error.code, remedy: error.remedy };
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
was 2542 JSON bytes; every source file hash stayed unchanged during preview.
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
replaying an atomic import can report a recovered content-keyed transaction
while the current SDK target differs after a peer edit. Reproduce with
`node test/ownership-inherited-replay.ts`. This observational feature does not
repair or certify inherited sync recovery.


## Re-review round 1: one mapping and complete trust validation

| General rule | Package-wide disposition |
| --- | --- |
| Compare through the write-path mapper | Ownership calls `buildItemPlan`, as atomic and legacy import do. SDK atomic dry-run results expose `prepared` plans from the actual writer preparation; CLI receipts keep their compact counts. SDK canonicalization handles status aliases, tags and whitespace; export's date projection remains shared. Omitted optional values retain the current target, as upserts do. Legacy updates now send empty mapped bodies and tags just as atomic updates do. |
| Match documented nullable API fields | One issue-field schema supplies import and ownership variants. Cycle names may be null or absent, and optional objects may be omitted. Legacy string-valued workflow types remain accepted by the shared mapper. Unsupported values produce a typed `source_invalid` naming the field. The [Linear cycle schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Cycle) defines `name` as nullable. |
| Validate before trusting any baseline row | All rows are inspected before the authority map is returned. Every occurrence of an invalid or duplicated known field is quarantined, in either order. Unidentifiable corrupt rows make the supplied baseline unknown; the item still produces a review plan. Mapping revision `linear-import-v2` prevents old-policy observations becoming authority under the corrected mapper. |
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
triples against **real atomic dry-run import plans**, using an HTTP fixture for
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


The final permanent 500-operation ownership model passed: one test, zero
failures, with 500 SDK dry-run comparisons and SDK state read-backs (1718.6
seconds for the test). The final atomic/tag sweep passed four tests, including
500 producer inputs and real updates/creates through both writers. All eleven
isolated behavioral reverts were rejected. The final packed rerun passed all
five modes. Full npm/Bun release-gate status remains separately reported in the
PR; interrupted local full attempts and earlier-head CI successes are excluded.
