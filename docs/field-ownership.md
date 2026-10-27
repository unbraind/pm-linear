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
cannot invent a shared value. A missing or invalid field record fails alone.
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
A long local attempt was stopped under host contention; full npm/Bun release
gates in CI provide the full-suite evidence at unchanged thresholds.

An inherited sync issue was independently reproduced and recorded as
[pm-linear-atomic-replay-revision](../.agents/pm/issues/pm-linear-atomic-replay-revision.toon):
replaying an atomic import can report a recovered content-keyed transaction
while the current SDK target differs after a peer edit. Reproduce with
`node test/ownership-inherited-replay.ts`. This observational feature does not
repair or certify inherited sync recovery.
