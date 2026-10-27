# pm-linear

Linear.app issue sync extension for [pm-cli](https://github.com/unbraind/pm-cli).

Fetches issues from a Linear team and upserts them as pm items, keeping identifiers, priorities, estimates, statuses, labels, due dates, assignees, cycles, customer names, and project names in sync. Also provides a native import pipeline (`pm linear import`) and an exporter (`pm linear export`) that renders pm items as Linear issue-create payloads, and declares `linear_id` / `linear_url` provenance fields.

## Capabilities

| Capability | Surface |
|------------|---------|
| `commands` | `pm linear sync`, `pm linear validate`, `pm linear schema`, `pm linear capture` |
| `importers` | `pm linear import` (+ legacy `linear-sync` importer) |
| `importers` (exporter) | `pm linear export` |
| `schema` | `linear_id`, `linear_url` item fields + command/importer/exporter flags |
| `preflight` | credential + reachability guard for commands that reach Linear |

> **Offline vs live.** `--dry-run` never writes to Linear, but "no writes" and
> "no network" are not the same thing:
>
> - **Offline** (no `LINEAR_API_KEY` needed): `sync`/`import`/`linear-sync import`
>   with `--dry-run` alone, and `export --dry-run` with or without `--push`. These
>   build and print the exact GraphQL request/variables, or the would-be
>   `issueCreate`/`issueUpdate` mutations, and make **no** network call.
> - **Reaches Linear** (live `LINEAR_API_KEY` required): the real (non-dry-run)
>   `sync`/`import`, `export --push`, `validate --check-network`, and
>   `sync`/`import` with **`--atomic --dry-run`** — the atomic preview fetches
>   issues in order to build the plan it reports, so it needs credentials even
>   though it writes nothing.
>
> The preflight gate follows exactly that split: it guards commands that *reach*
> Linear, not commands that *mutate* it.

---

## Requirements

- pm-cli / `@unbrained/pm-cli` SDK `>=2026.10.4`, resolvable from the installed extension
- Node.js `>=22.18.0`
- A Linear API key with read access to the relevant teams (only for **live**
  paths; every `--dry-run` and offline `validate` works without one)

---

## Setup

### 1. Get a Linear API key

1. Go to **Linear → Settings → API** (`https://linear.app/settings/api`)
2. Create a **Personal API key** (or a workspace key for shared use)
3. Copy the key into your shell environment.

### 2. Set the environment variable

```bash
export LINEAR_API_KEY=<linear-api-key>
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) to persist it.

### 3. Install the extension

```bash
pm install npm:pm-linear --global
```

> The `npm:` prefix is required. A bare `pm install pm-linear` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-linear` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

Or install per-project:

```bash
pm install npm:pm-linear --project
```

---

## Commands

### Selected thread capture plans

`pm linear capture --thread ROOT_COMMENT_ID --item EXISTING_ITEM_ID` proposes an
attributed, revisioned core evidence note from one explicitly selected discussion
and its direct replies. Preview and metadata-only disclosure are the defaults;
`--disclosure text` explicitly includes bodies and names. Deliver a reviewed
proposal with `--apply --revision TOKEN`. Reimport deduplicates through the SDK;
source edits append new evidence without replacing previous revisions. No items
are created and no discussions are discovered or harvested in the background.
TOON is the default; `--json` returns the same compact receipt. The typed SDK
exports `captureLinearThread`, options/report/note types and actionable
`ThreadCaptureRefusal` codes. See the [complete example and disclosure contract](docs/thread-capture.md).

### `pm linear sync`

Fetches issues from a Linear team and syncs them into pm items.

```
pm linear sync --team <slug> [options]
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--team` | string | *(required)* | Linear team slug (e.g. `ENG`, `BACKEND`) |
| `--project` | string | — | Filter by Linear project name |
| `--state` | string | — | Filter by state name (e.g. `"In Progress"`) |
| `--cycle` | string | — | Filter by cycle name (e.g. `"Sprint 7"`, `"Q3"`); case-insensitive substring match, issues with no cycle are excluded |
| `--assignee` | string | — | Filter by assignee email |
| `--label` | string | — | Filter by label name |
| `--updated-since` | string | — | Only issues updated at/after an ISO date or duration (e.g. `2026-01-01`, `-P7D`) |
| `--status-map` | string | — | Override status mapping, e.g. `"In Review=in_progress,Backlog=open"` |
| `--map` | string | — | Remap Linear→pm fields, e.g. `"identifier=ignore,priority=ignore"` |
| `--project-map` | string | — | Tag items by Linear project name (additive). Bare flag tags with the verbatim name; `"Mobile=mobile,Web=web"` remaps |
| `--limit` | number | `100` | Max issues to fetch |
| `--dry-run` | boolean | `false` | Print the exact GraphQL request, no writes. **Offline** on its own; with `--atomic` it fetches issues to build the plan and needs `LINEAR_API_KEY` |
| `--skip-preflight-network` | boolean | `false` | Skip the preflight reachability probe (offline/CI) |

#### `--map` field remapping

`--map linearField=pmField[,…]` adjusts how Linear fields feed pm fields at
import time. The special value `ignore` suppresses a field:

| `--map` entry | Effect |
|---------------|--------|
| `identifier=ignore` | Drop the `[ENG-1] ` prefix from the pm title |
| `priority=ignore` | Skip priority (pm item gets the default) |
| `labels=ignore` | Skip label→tag import (also drops the `cycle:<name>` tag) |
| `status=ignore` | Skip status mapping (pm item stays `open`) |
| `assignee=ignore` | Skip assignee import (pm item left unassigned) |
| `estimate=ignore` | Skip the `estimate:<points>` context tag |
| `customer=ignore` | Skip the `customer:<name>` context tag |

#### `--project-map` project tagging

`--project-map` is **additive**: imported items keep their label-derived tags and
gain one more tag for their Linear project. It mirrors `--status-map`.

| `--project-map` value | Effect |
|-----------------------|--------|
| *(bare flag)* / `*` / `true` | Passthrough — tag each item with its verbatim Linear project name |
| `"Mobile App=mobile,Web=web"` | Remap — tag matched projects with the mapped value; an unmatched project falls back to its own name |
| `"Legacy=ignore"` | Suppress tagging for that specific project |

```bash
# Tag every imported item with its Linear project name
pm linear sync --team ENG --project-map

# Map project names to short tags
pm linear sync --team ENG --project-map "Mobile App=mobile,Web=web"
```

#### Examples

```bash
# Sync all open issues from the ENG team
pm linear sync --team ENG

# Only sync issues currently In Progress
pm linear sync --team ENG --state "In Progress" --cycle "Sprint 7"

# Restrict to a single Linear project
pm linear sync --team ENG --project "Q3 Roadmap"

# Custom status mapping (Linear state name -> pm status)
pm linear sync --team ENG --status-map "In Review=in_progress,Backlog=open"

# Sync up to 200 issues from the BACKEND team
pm linear sync --team BACKEND --limit 200

# Preview what would be synced (no writes)
pm linear sync --team ENG --dry-run
```

---

## `pm linear import`

Native import pipeline. Pulls issues from a Linear team (and optional project) via the
GraphQL API and creates pm items. Accepts the same `--team`, `--project`, `--state`, `--cycle`,
`--assignee`, `--label`, `--updated-since`, `--status-map`, `--map`, `--project-map`,
`--limit`, and `--dry-run` flags as `pm linear sync`.

```bash
pm linear import --team ENG
pm linear import --team ENG --project "Q3 Roadmap" --limit 50
pm linear import --team ENG --dry-run
```

Requires `LINEAR_API_KEY` (or falls back to `LINEAR_DEFAULT_TEAM` for the team). When
the key is missing it exits non-zero with a structured error rather than crashing.

## Complete local reads

Sync/import matching, offline import previews, and export read the entire local
tracker through the public in-process SDK `listAllComplete({ includeBody: true })`.
The read includes closed and canceled items, all item types, full metadata and
bodies, with strict source checks and unbounded row/output budgets. Extension
hooks are disabled for this observational read. There is no 10,000-item limit or
CLI JSON buffer ceiling.

Before planning writes, pm-linear verifies the completeness certificate, source
and output receipts, and the fields used for matching/export. It refuses missing
`items`, missing or invalid certificates, partial/unverified scans, pagination,
count mismatches, duplicate/invalid IDs, partial projections, field omissions,
compacted/omitted output, read-session projections, missing bodies, and malformed
rows with a `CommandError`. Import certifies before fetching issues; export
certifies before provider lookups or mutations. An unreadable tracker also fails
an offline preview instead of reporting a misleading zero matching count.

The error includes a recovery hint: install/upgrade the SDK, repair unreadable
tracker artifacts, and retry. For a diagnostic complete CLI read, use:

```bash
pm list --all --full --include-body --strict-read --no-truncate --output-budget unbounded --output-limit unbounded --json
```

See [real-tracker acceptance and refusal evidence](docs/complete-local-reads.md).

The extension loads the SDK lazily so command discovery still works on older or
standalone hosts. Local reads require a resolvable SDK at the minimum version;
an unavailable SDK fails with the same recovery hint.

## `pm linear export`

Renders pm items as Linear issue-create payloads. The exported payload is
**symmetric with the importer**: a pm item's `priority`, `tags`, `deadline`,
`estimate:<n>` tag, and `cycle:<name>` tag are carried into the Linear mutation as
`priority` (int), `labelIds` (resolved from tag names to the team's existing
labels at push time), `dueDate` (`YYYY-MM-DD`), `estimate` (int), and `cycleId`
(resolved from the cycle name to the team's cycle at push time) respectively —
alongside `title`, `description`, and the status→state mapping.

The importer encodes Linear's estimate and cycle as the namespaced tags
`estimate:<points>` and `cycle:<name>` (pm has no first-class field for either).
Export promotes those tags back to first-class Linear issue fields and does **not**
re-emit them as Linear labels, so the round-trip is lossless and clean.

- **Default (no `--push`):** prints the JSON payload to stdout. Safe, read-only, no
  network. Items that already carry Linear provenance are flagged `alreadyInLinear: true`.
- **`--push`:** creates/updates the issues in Linear. Only mutates Linear when **both**
  `--push` is set **and** `LINEAR_API_KEY` is present, and requires `--team <slug>` to
  resolve the target team (and its labels/states). Items already linked to Linear are
  updated in place so the push is idempotent. Tags that don't match an existing team
  label are dropped rather than failing the push. A per-item create/update failure
  is isolated: it is logged, counted as `skipped`, and the batch continues rather
  than aborting the remaining items.

```bash
# Preview the payload (no network, no writes)
pm linear export

# Create the issues in Linear (requires LINEAR_API_KEY)
pm linear export --push --team ENG
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--push` | boolean | `false` | Create the issues in Linear (requires key + `--team`) |
| `--team` | string | — | Target Linear team slug (required with `--push`) |
| `--map` | string | — | Suppress export fields, e.g. `"estimate=ignore,cycle=ignore"` |
| `--dry-run` | boolean | `false` | **Offline** — print the would-be `issueCreate`/`issueUpdate` mutations + variables, no network |

> **Cycle resolution.** The `cycle:<name>` tag carries a cycle **name**; Linear's
> mutation input needs a `cycleId`. On `--push`, the exporter resolves the name
> against the team's cycles (fetched alongside its labels/states) and sets
> `cycleId` when it matches (by cycle name or number, case-insensitively). A cycle
> name that doesn't resolve — offline, unknown, or a workspace that doesn't model
> it — is **skipped** (the rest of the issue still pushes) with a single stderr
> warning per push. Use `--map cycle=ignore` to drop cycle export entirely, or
> `--map estimate=ignore` to drop estimate.

```bash
# Preview the exact Linear mutations that a --push would send (no network)
pm linear export --dry-run --team ENG
```

## Linear schema negotiation

`pm linear schema --team ENG` reads the team's current workflow states, team and
workspace labels, cycle/triage/estimation settings and default state. It uses the
pm SDK's local status registry to check every `--status-map` target. This command
always reaches Linear and needs a key with **Read** access to the target team.
It performs no tracker or Linear writes. `linear validate` remains a configuration
and credential diagnostic; it does not certify mapping compatibility.

```bash
# Compact TOON by default; JSON for a persisted automation receipt
pm linear schema --team ENG --status-map "Review=in_progress"
pm --json linear schema --team ENG --status-map "Review=in_progress"

# Copy schemaVersion from the report; use the same mapping when applying
pm linear sync --team ENG --atomic --status-map "Review=in_progress" \
  --schema-version "linear-schema-v1:<reported-sha256>"
```

Every live sync, native import and legacy import negotiates automatically before
fetching issues and rechecks the version after fetching, before local writes.
`--schema-version` additionally binds an invocation to an earlier reviewed report.
Deleted/archived labels, label renames, state renames (even with the same status),
state type changes, team identity/settings changes, local status definition
changes and override changes invalidate the old version. Discovery follows both
metadata connections to completion, including workspace labels; partial metadata,
duplicate IDs and broken pagination fail closed. There are at most 1,000 pages.

Reports use format version `1` and a `linear-schema-v1:` SHA-256 version. Digest
ordering uses UTF-16 code units, independent of runtime locale and ICU. Reports
include settings, total counts, the first 32 state mappings, `omittedStates`, and
a digest of **all** labels. Negotiation and hashing always cover every mapping
and label; preview truncation never weakens the check. Sync also returns the
report in its structured `schema` field and emits it to stderr before applying.
No issue bodies or credentials appear in the report.

SDK callers can import `negotiateLinearSchema`, `LinearSchemaOptions`,
`LinearSchemaReport`, `SyncOptions`, `SyncResult`, `LinearSchemaRefusal` and
`LinearSchemaRefusalCode` from `pm-linear`. Refusals carry `code`, `remedy`, exit
code `2`, and a fresh `report` when a version comparison fails.

| Refusal | Remedy |
| --- | --- |
| `access_denied` | Restore Read permission for the target team, states, settings and labels; check the team key/API schema support. |
| `schema_unavailable` | Restore connectivity or repair the local SDK/schema, then retry discovery. |
| `metadata_incomplete` | Restore full metadata and stable, complete pagination before retrying. |
| `mapping_invalid` | Remove stale overrides or register/correct the target pm status. |
| `schema_drift` | Run `linear schema` again, review the new report and use its version. |

An offline `--dry-run` still makes no network request and cannot certify remote
metadata. `--atomic --dry-run` negotiates and previews against current metadata.
Negotiation proves **read** access for importing; it does not attest Linear write
permissions or gate export/push. Linear exposes no cross-request metadata snapshot
transaction: a provider change after the final check remains a race. Run schema
review and apply close together; `--atomic` protects the local batch.

See the [SDK example and measured validation](docs/schema-negotiation.md).

## Field ownership conflict previews

`pm linear ownership --item ITEM --base acknowledged.json` compares the last
explicitly acknowledged observation with current local and Linear values. It
returns a compact host-rendered TOON receipt, or JSON with `--json`. No field
text is included: the reusable observation contains field hashes and revision
digests. Digests are change indicators, not anonymization of low-entropy data.

```sh
pm linear ownership --item pm-example --json > preview.json
# Review both systems. Only after acknowledging the observation:
jq '.observation' preview.json > acknowledged.json
pm linear ownership --item pm-example --base acknowledged.json --json
```

The preview reports `local_edit`, `provider_edit`, `conflict`, `aligned`,
`unchanged`, or `unknown_base` per field. `disjoint: true` requires local and
provider edits on different fields, with no conflicts or unknown fields. An
absent, foreign, changed-mapping, malformed, duplicate, or previously divergent
field base never implies a safe overwrite. Baselines are supplied explicitly;
preview does not write acknowledgements, notes, settings, histories or Linear.

The comparison covers the import projection: title (including the issue
identifier), body, status, priority, tags (including cycle/estimate/customer),
deadline and assignee, plus provenance description. Both sides use SDK
canonicalization; due dates use the existing export date mapping. Lifecycle
mapping uses the configured SDK registry roles and optional `--status-map`,
never guesses from status names. Custom import field/project mappings are not
inferred; use this command for the documented default import projection.

This is an observation for review with **no atomic cross-system guarantees**.
Repeated local and provider reads detect observable drift, but cannot establish
a transaction or prevent later edits. The command offers no apply operation.
Re-read both systems before any separate write. Linear does not gain ADO's
revision-test primitive through this command.

`--max-output-bytes` accepts integers 2048..65536 (default 8192); the complete
representation of the JSON receipt must fit or the command refuses instead of
truncating it. The budget measures compact UTF-8 JSON; host pretty-printing may
add whitespace. One
provider issue is selected, with two bounded read requests, no automatic retries,
at most 128 labels and a 128 KiB response cap. Partial label connections refuse.
Provider text fields are bounded to 32768 characters, priority to integers 0..4,
and estimate to finite numbers 0..1000000. Baseline JSON files are limited to
16 KiB and eight dense field records. Existing local content is read through
the SDK without applying new content filters.

The typed SDK export is `previewLinearOwnership(options, pmRoot)` with
`LinearOwnershipOptions`, `LinearOwnershipSnapshot`, `LinearOwnershipReport`
and `LinearOwnershipRefusal`. Stable refusal codes are `invalid_input`,
`local_read_failed`, `selection_required`, `access_denied`, `source_invalid`,
`source_changed` and `output_budget`; each carries a remedy and exit code 2.
See the [SDK example and measured validation](docs/field-ownership.md).

## Without git

Field ownership previews, focused dependency closure, thread capture, schema negotiation, validate, sync/import and export work in
plain pm trackers without a git executable. Live provider operations still need
Linear access; offline previews work without credentials. Release tooling that
reads git tags needs a repository, separately from tracker operations.

## `pm linear validate`

Readiness diagnostics. Reports whether `LINEAR_API_KEY` and `LINEAR_DEFAULT_TEAM`
are configured — **without leaking the key** (only a short prefix + length are
shown) — and whether the workspace is ready for writes. Offline by default;
`--check-network` (opt-in) probes the Linear API to confirm the key is accepted.

```bash
pm linear validate                # offline: config presence only
pm --json linear validate         # structured report
pm linear validate --check-network # live: confirm the key is accepted (needs key + network)
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--check-network` | boolean | `false` | Probe the Linear API to confirm the key is accepted (needs network) |

---

## Provenance fields

The extension declares two custom item fields (`registerItemFields`):

| Field | Type | Description |
|-------|------|-------------|
| `linear_id` | string (optional) | Linear issue UUID |
| `linear_url` | string (optional) | Canonical Linear issue URL |

Because `pm create` has no generic setter for extension-declared fields, imported items
encode provenance in their description behind a stable `[linear]` marker
(`[linear] linear_id=… linear_url=…`). `pm linear export` reads this marker back so
already-linked items are not re-created on `--push`.

---

## Programmatic importer

The extension registers a `linear-sync` importer for use in pm config or pipelines:

```json
{
  "importers": [
    {
      "name": "linear-sync",
      "config": {
        "team": "ENG",
        "limit": 100
      }
    }
  ]
}
```

Set `LINEAR_DEFAULT_TEAM` as a fallback if `team` is not specified in config:

```bash
export LINEAR_DEFAULT_TEAM=ENG
```

---

## Field mapping

### Priority

| Linear priority | Linear label | pm priority |
|----------------|--------------|-------------|
| 1 | Urgent | 1 (Urgent) |
| 2 | High | 2 (High) |
| 3 | Medium | 3 (Medium) |
| 4 | Low | 4 (Low) |
| 0 | No priority | 3 (Medium) |

### Status

The importer maps every Linear issue to one of pm's four statuses —
`open`, `in_progress`, `closed`, `blocked`:

| Linear state type / name | pm status |
|--------------------------|-----------|
| type `started` (In Progress, In Review) | `in_progress` |
| type `completed` / `canceled` / `duplicate` (also legacy `cancelled`) | `closed` |
| name contains "in progress" / "in review" | `in_progress` |
| name contains "blocked" | `blocked` |
| name contains "done" / "completed" / "canceled" / "cancelled" | `closed` |
| everything else (Todo, Backlog, Triage, unstarted) | `open` |

A `--status-map "Linear State=pm_status,…"` overrides this heuristic
(matched **case-insensitively** on the Linear state name) and is inverted to
drive the export/push direction (pm status → Linear state name). The inverted
direction echoes the Linear state name with its **original casing** preserved
(`Backlog`, not `backlog`).

### Item fields (import: Linear → pm)

`pm create`/`pm update` is the only setter available to a standalone extension,
so imported issues map onto pm's first-class fields (there are **no**
`meta.linear_*` fields):

| pm field | Linear source |
|----------|---------------|
| `title` | `[ENG-123] Issue title` (the `[ENG-123]` prefix can be dropped with `--map identifier=ignore`) |
| `body` | `description` |
| `status` | mapped from `state.type` / `state.name` (see above) |
| `priority` | mapped from `priority` |
| `tags` | label names |
| `tags` (`cycle:<name>`) | `cycle.name` — the issue's Linear cycle, encoded as a namespaced tag |
| `tags` (project) | `project.name` — only when `--project-map` is supplied (see above) |
| `deadline` | `dueDate` (if set) |
| `assignee` | `assignee.email` (or `assignee.name` when no email); suppress with `--map assignee=ignore` |
| `description` marker | `[linear] linear_id=… linear_url=…` provenance (see below) |

> **Cycle encoding.** pm has no first-class cycle/sprint field reachable from a
> standalone extension's `pm create`, so the Linear cycle is stored as a
> `cycle:<name>` tag (additive, de-duplicated). Filter on it with
> `pm list --tag "cycle:Sprint 7"`.

`pm linear export` reverses the core mapping so a round-trip is lossless for the
fields it carries:

| Linear input field | pm source |
|--------------------|-----------|
| `title` | `title` |
| `description` | `body` |
| `stateName` / `stateId` | mapped from `status` (via inverted `--status-map`) |
| `priority` | `priority` (pm 1–4 → Linear 1–4, else `0` "No priority") |
| `labelIds` | `tags` (resolved to existing team labels; unknowns dropped; `estimate:`/`cycle:` tags excluded) |
| `dueDate` | `deadline` (normalized to `YYYY-MM-DD`) |
| `estimate` | `estimate:<n>` tag (integer; suppress with `--map estimate=ignore`) |
| `cycleId` | `cycle:<name>` tag (name resolved to the team's cycle id at push time; skipped if unresolved; suppress with `--map cycle=ignore`) |

> Export does not currently push assignee back to Linear (import-direction only).

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | Yes | Linear personal or workspace API key |
| `LINEAR_DEFAULT_TEAM` | No | Default team slug for the importer (if not set in config) |

---

## Development

```bash
# Install dev deps
npm install

# Build TypeScript → dist/
npm run build

# Watch mode
npm run dev
```

The compiled output lands in `dist/index.js`, which is the entry point referenced by `manifest.json`.

---

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver definitions live in per-clone
Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## Focused Linear prerequisites

`pm linear closure` acquires missing prerequisite context for explicitly selected,
linked pm items. It reads incoming Linear `blocks` relations, including archived
relations, and follows them within declared budgets. Core `pm deps`, pm-context
and pm-graph continue to handle relationships already available locally.

```sh
pm linear closure --items pm-example --max-depth 3 --max-nodes 32 --max-requests 64 --json
pm linear closure --items pm-one,pm-two --max-relations 128
```

The second form uses the host's default TOON rendering. For larger receipts, set
host `--output-budget unbounded --output-limit unbounded` to retain every row.
Only Read access is needed in `LINEAR_API_KEY`. A selection must already carry
the provenance written by `pm linear import` or `sync`; unlinked selections are
refused before any HTTP request. There is no full-team query or apply mode.

For `selected -> B -> C -> D`, with only selected imported, `frontier` is
`[B,C,D]`, `measured` is `{nodes:4,requests:4,relations:3}`, and every issue has
its depth and local item ID (or null). All known missing blockers remain listed,
including identities beyond the node/depth cap. `issues[].read` distinguishes
acquired context from identities awaiting a successful read.

`complete: false` preserves `boundaries` with a reason and remedy for denied
access, unavailable transport, or an exhausted cap. A hidden relation whose
identity is unavailable produces a boundary on its source. **Neither complete
acquisition nor an empty frontier establishes readiness to act.** Read imported
context and unresolved boundaries before acting. No local or Linear status name
is interpreted or used to hide a prerequisite.

| Flag | Default | Accepted integer range |
| --- | ---: | ---: |
| `--max-depth` | 3 | 0..8 |
| `--max-nodes` | 32 | 1..128 |
| `--max-requests` | 64 | 1..256 |
| `--max-relations` | 128 | 1..1024 |
| `--max-output-bytes` | 16384 | 1024..131072 |

Select 1..16 distinct items. Node counts include selected roots; relation counts
include non-blocking rows examined. Each actual HTTP attempt consumes one
request; failures never trigger hidden retries. Pages contain at most 50 rows
and transport responses are capped at 256 KiB. JSON receipts reserve 256 bytes
for transport wrapping; oversized output is refused rather than truncated.

```ts
import { fetchLinearDependencyClosure, LinearClosureRefusal } from "pm-linear";

const report = await fetchLinearDependencyClosure(
  { items: ["pm-example"], maxDepth: 3, maxRequests: 16 }, trackerRoot,
);
// On refusal, LinearClosureRefusal exposes code, remedy and exitCode (2).
```

The SDK and command work without Git and leave the source tracker byte-identical.
Because the pinned SDK writes derived read caches and feedback, certified reads
run only after a bounded physical isolation copy (at most 20,000 entries / 64 MiB),
without an item-folder filter. SDK complete enumeration and `locateItem` then
select the exact item files for a final read view with its configuration. Even
missing settings/schema files are bootstrapped only in owned copies. Copies are
removed after each read; the source's permissions never change. Membership is re-read before
returning; observed local edits, paging drift, malformed data or ambiguous
provenance produce typed refusals. Provider observations are not an atomic
cross-issue snapshot. See [validation and limits](docs/dependency-closure.md).
