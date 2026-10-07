# Complete local reads for Linear reconciliation and export

Tracked by [GitHub issue 134](https://github.com/unbraind/pm-linear/issues/134) and
[pm-linear-ldqw](../.agents/pm/issues/pm-linear-ldqw.toon).

## Mechanism and runtime contract

`readPmItems` lazily loads `@unbrained/pm-cli/sdk/runtime` and calls:

```ts
await sdk.listAllComplete(
  { includeBody: true },
  { pmRoot, noExtensions: true },
);
```

The minimum peer version is the tested public SDK contract, `2026.10.4`.
Lazy loading preserves extension discovery on older standalone hosts. Reads
require a resolvable SDK; missing/older SDKs produce an actionable `CommandError`.
There is no bounded CLI fallback. Packed npm and native Bun consumers both
export a closed item with its complete body even with an empty `PATH`.

The SDK requests all lifecycle statuses, full metadata, strict source scans,
no pagination ceiling, and unbounded output amount/cost. Extension discovery is
disabled for the observational read. Sync/import certifies before fetching
provider issues or writing local items; export certifies before provider lookups
or writes. Offline import previews certify their matching count too.

`certifyPmItems` re-certifies the envelope with the public
`certifyCompleteListResult` and checks the returned `complete_list` proof against
that certificate. The SDK certificate validates row IDs; it does not establish
the shape of every field consumed by Linear. The extension therefore checks
nonblank IDs/titles/statuses, mandatory string bodies, optional string
description/deadline, integer priority in 0..4, and string-array tags. It requires
the `include_body` request echo as well. All rows are checked before any row is
returned to matching or export planning. Custom nonblank status values remain
valid; closed/canceled work is part of the matching index.

## Refusal table

All refusals use `CommandError` with failure exit code 1 and a hint to upgrade the
SDK, repair unreadable tracker artifacts, and retry the complete read. The hint
also includes the canonical all-status/full/body/strict/unbounded CLI diagnostic.

| Answer or source condition | Refusal boundary |
| --- | --- |
| Missing/null/array envelope; missing `items`; `results` alias; non-array `items` | SDK envelope certification |
| Partial or unchecked source; unreadable/malformed tracker artifact | Strict SDK scan and source certification |
| `truncated`, `has_more`, `next_cursor`, row limit; inconsistent count/total | SDK pagination/count certification |
| Filtered corpus, terminal exclusion, absent strict-read proof | SDK source-scope certification |
| Brief/projected fields; field omissions; missing/malformed omission receipt | SDK projection/omission certification |
| Missing/invalid read receipt or dimensions; string/row compaction; budget truncation/omission | SDK universal read-output certification |
| Read-session projection | SDK cross-call scope certification |
| Missing/invalid/duplicate IDs | SDK identity certification |
| Missing/malformed/contradictory `complete_list` | Extension certificate comparison |
| Missing body echo; missing/malformed body; malformed consumed row fields | Extension row/projection validation |
| Unavailable SDK or uninitialized tracker | Extension handled read failure |

## Real-tracker acceptance and revert proof

`test/complete-local-reads.test.ts` initializes disposable trackers through the
real `PmClient`. Its large fixture uses public `commitImportedItem` in-process,
writing real TOON documents and per-item history for 10,002 items. Export must
retain all items and the last body; atomic import preview must match the last
Linear provenance instead of planning a duplicate. Legacy and atomic re-import
cases start with closed and canceled local work, update those existing IDs, and
require the second import to create zero items. An atomic journal replay may
report recovered items rather than fresh updates.

The 48 refusal controls degrade copies of an actual `listAllComplete` result;
they do not replace or mock the SDK. Each must fail before the synthetic fetch
seam or atomic commit seam runs. A separate malformed-source fixture exercises
real strict SDK refusal through import and preview/push export handlers and
verifies the damaged item remains unchanged.

For the revert check, a disposable source copy restored `readPmItems` verbatim
from base commit `79176f2` and exposed the original JSON decoder to the same
refusal cases. The production worktree source remained fixed. The same tests
failed as follows:

| Test | Original reader/decoder | Certified reader |
| --- | --- | --- |
| 10,002-item export | 10,000 exported; assertion fails | 10,002 with retained bodies |
| Terminal matching, legacy | 3 creates instead of 1; assertion fails | 1 create, 2 updates; second import creates 0 |
| Terminal matching, atomic | 3 creates instead of 1; assertion fails | 1 create, 2 updates; second import creates 0 |
| 48 degraded-envelope refusals | All 48 fail the refusal assertion | All 48 refuse before fetch/commit |

The revert command selected `complete local corpus|terminal matching|every degraded`
from the copied test file with `node --test --test-name-pattern=...`. The old
reader and decoder controls are separate: the reader is restored byte-for-byte;
the decoder is exposed at the certification seam solely to exercise its exact
JSON-envelope interpretation against the real result degradations.

## Validation commands and scope

```bash
node --test test/complete-local-reads.test.ts
node --test --test-name-pattern=every.degraded test/complete-local-reads.test.ts
npm run release:check
bun run release:check
npm run changelog:full
```

The refusal command is linked to the item and was executed with
`pm test pm-linear-ldqw --run --progress`. Both full release commands are linked
as well. Coverage thresholds remain lines 99%, branches 96%, functions 100%,
with the existing source inventory gate and no added exclusions. These checks
cover local behavior and synthetic loopback provider fixtures; they make no
live Linear-service acceptance claim.

An independent legacy-upsert limitation found during testing is recorded as
[pm-linear-uhu6](../.agents/pm/issues/pm-linear-uhu6.toon): a legacy update to a
closed state omits the close reason required by strict governance. This change
certifies matching; that closure behavior remains follow-up work.
