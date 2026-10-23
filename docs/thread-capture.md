# Selected Linear discussion evidence

Capture one top-level Linear comment and its direct replies as a proposed core
note on an **existing** pm item. No issue is created, no status is changed, and
no workspace discussions are discovered. Every invocation selects its root ID.
This complements pm-review's GitHub review findings and pm-observer's explicit
agent exports; native `pm notes` owns persistence and append-only history.

```sh
pm linear capture --thread ROOT_COMMENT_ID --item EXISTING_ITEM_ID --json
# Review proposedNote, itemId, disclosure and revision before delivery.
pm linear capture --thread ROOT_COMMENT_ID --item EXISTING_ITEM_ID \
  --apply --revision REVIEWED_TOKEN --json
```

Preview is the default. `--disclosure metadata` (the default) exposes Linear
comment IDs, the root URL, author IDs/kinds, timestamps, and body/name digests.
It omits bodies and display names. `--disclosure text` explicitly includes exact
Markdown bodies and names in both output and stored notes. Hashes and provider
identifiers are sensitive metadata, not anonymization. Review the destination's
access policy before delivery: core notes are not an encryption or access-control
boundary. Changing disclosure creates a separate proposal; it does not erase
previous notes or append-only history. Unknown integration authors remain
explicitly `unknown`; external users keep their separate attribution.

The selected root and all direct replies are paginated with archived replies
included, read twice, validated, and sorted by stable ID. Each source revision
includes body/name digests and timestamps, so edits remain visible even with
unchanged provider timestamps. Reply additions/removals change the fingerprint.
The preview token binds the complete proposal, destination tracker identity,
canonical target ID and disclosure. Tracker identity is an opaque digest of the
SDK-resolved canonical tracker path and settings ID prefix. Workspace/storage
path spellings and symlink aliases of the same tracker retain the token; another
tracker with the same item ID and settings prefix does not. Relocating a tracker
requires a fresh preview. Raw tracker paths are never included in output or notes.
Apply re-reads the source and refuses a stale token before a note append. Two
matching reads detect observable drift; Linear does not provide an atomic
snapshot or a guarantee that the discussion remains unchanged after the read.
Only direct replies are covered; selecting a reply cannot implicitly select its
parent. The root must be explicitly selected. Deleted or inaccessible roots
refuse; captures never infer deletion from a missing root.

Delivery uses SDK `notes({ addJson, ifAbsent: true })`. The immutable structured
event has type `linear.thread-evidence.v1`; the importing author is `pm-linear`
and each source author remains attributed inside the event. Identical concurrent
or repeated delivery adds one note. New revisions append evidence and preserve
the old one. `sourceChanged` and `previousSourceRevision` compare the latest
captured source revision; `duplicate` reports an already recorded proposal.
Both metadata and text proposals have the same source revision. Source revision
is a fingerprint of observed API data, not a signed provider attestation.

Output defaults to the host's native TOON; global `--json` returns the same typed
receipt. The default complete JSON receipt budget is 8192 bytes, configurable with
`--max-output-bytes 1024..65536`. Budget validation reserves receipt space before
writes and refuses oversized proposals instead of silently dropping evidence.
Threads are limited to 100 comments including the root, each body to 65536 UTF-8
bytes. No attachments, email addresses, generated thread summaries, reactions or
nested child threads are requested. No provider mutation is sent. Read access
requires `LINEAR_API_KEY`; the existing HTTP retry, timeout and endpoint rules
apply. Refusals expose `ThreadCaptureRefusal.code` and `.remedy` in the SDK and a
handled diagnostic in the CLI. `write_unconfirmed` means delivery might have
persisted: restore tracker access/ownership and retry the identical proposal.

```ts
import { captureLinearThread, ThreadCaptureRefusal } from "pm-linear";
import type { ThreadCaptureOptions, ThreadCaptureReport } from "pm-linear";

/** Preview only: this function never opts into note delivery. */
export async function previewSelectedThread(
  pmRoot: string,
  selection: ThreadCaptureOptions,
): Promise<ThreadCaptureReport> {
  return captureLinearThread({ ...selection, apply: false, revision: undefined }, pmRoot);
}

/** Deliver the exact reviewed proposal; source or disclosure drift refuses. */
export async function deliverReviewedThread(
  pmRoot: string,
  selection: ThreadCaptureOptions,
  reviewed: ThreadCaptureReport,
): Promise<ThreadCaptureReport | { refused: true; code: string; remedy: string }> {
  try {
    return await captureLinearThread({ ...selection, apply: true, revision: reviewed.revision }, pmRoot);
  } catch (error: unknown) {
    if (error instanceof ThreadCaptureRefusal) return { refused: true, code: error.code, remedy: error.remedy };
    throw error;
  }
}
```

For reproducible public-data validation, place a read-only copy of a **public**
fleet tracker in a plain directory outside git and set `PM_LINEAR_PUBLIC_TRACKER`
to that directory. Run
`node --test --test-name-pattern='public tracker validation' test/thread-capture.test.ts`.
The regression reads the complete corpus through the pinned SDK, derives up to
20 provider-shaped threads from public titles, applies and replays them in a
separate disposable tracker, checks visible source edits, and verifies every
source-copy file hash remains unchanged. It prints only aggregate counts and
maximum JSON bytes. This measures public-tracker-derived evidence, not live
Linear discussion access or provider snapshot guarantees. All committed fixtures
are synthetic. The same no-git regression suite removes git from `PATH` and sets
`GIT_CEILING_DIRECTORIES` to prevent ancestor discovery.

Provider contract references: [Linear GraphQL](https://linear.app/developers/graphql),
[pagination](https://linear.app/developers/pagination), and the official
[Comment schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
