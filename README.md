# pm-linear

Linear.app issue sync extension for [pm-cli](https://github.com/unbraind/pm-cli).

Fetches issues from a Linear team and upserts them as pm items, keeping identifiers, priorities, statuses, labels, and due dates in sync. Also provides a native import pipeline (`pm linear import`) and an exporter (`pm linear export`) that renders pm items as Linear issue-create payloads, and declares `linear_id` / `linear_url` provenance fields.

## Capabilities

| Capability | Surface |
|------------|---------|
| `commands` | `pm linear sync`, `pm linear validate` |
| `importers` | `pm linear import` (+ legacy `linear-sync` importer) |
| `importers` (exporter) | `pm linear export` |
| `schema` | `linear_id`, `linear_url` item fields + command/importer/exporter flags |
| `preflight` | credential + reachability guard for mutating commands |

> **Offline vs live.** Every `--dry-run` path (import **and** export) is fully
> **offline** — it builds and prints the exact GraphQL request/variables (import)
> or the would-be `issueCreate`/`issueUpdate` mutations (export) and makes **no**
> network call. Only the real (non-dry-run) `sync`/`import`, `export --push`, and
> `validate --check-network` reach the Linear API and require a live
> `LINEAR_API_KEY`.

---

## Requirements

- pm-cli `>=2026.5.31`
- Node.js `>=20`
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
pm install github.com/unbraind/pm-linear --global
```

Or install per-project:

```bash
pm install github.com/unbraind/pm-linear --project
```

---

## Commands

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
| `--assignee` | string | — | Filter by assignee email |
| `--label` | string | — | Filter by label name |
| `--updated-since` | string | — | Only issues updated at/after an ISO date or duration (e.g. `2026-01-01`, `-P7D`) |
| `--status-map` | string | — | Override status mapping, e.g. `"In Review=in_progress,Backlog=open"` |
| `--map` | string | — | Remap Linear→pm fields, e.g. `"identifier=ignore,priority=ignore"` |
| `--limit` | number | `100` | Max issues to fetch |
| `--dry-run` | boolean | `false` | **Offline** — print the exact GraphQL request, no network/writes |
| `--skip-preflight-network` | boolean | `false` | Skip the preflight reachability probe (offline/CI) |

#### `--map` field remapping

`--map linearField=pmField[,…]` adjusts how Linear fields feed pm fields at
import time. The special value `ignore` suppresses a field:

| `--map` entry | Effect |
|---------------|--------|
| `identifier=ignore` | Drop the `[ENG-1] ` prefix from the pm title |
| `priority=ignore` | Skip priority (pm item gets the default) |
| `labels=ignore` | Skip label→tag import |
| `status=ignore` | Skip status mapping (pm item stays `open`) |

#### Examples

```bash
# Sync all open issues from the ENG team
pm linear sync --team ENG

# Only sync issues currently In Progress
pm linear sync --team ENG --state "In Progress"

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
GraphQL API and creates pm items. Accepts the same `--team`, `--project`, `--state`,
`--assignee`, `--label`, `--updated-since`, `--status-map`, `--map`, `--limit`, and
`--dry-run` flags as `pm linear sync`.

```bash
pm linear import --team ENG
pm linear import --team ENG --project "Q3 Roadmap" --limit 50
pm linear import --team ENG --dry-run
```

Requires `LINEAR_API_KEY` (or falls back to `LINEAR_DEFAULT_TEAM` for the team). When
the key is missing it exits non-zero with a structured error rather than crashing.

## `pm linear export`

Renders pm items as Linear issue-create payloads.

- **Default (no `--push`):** prints the JSON payload to stdout. Safe, read-only, no
  network. Items that already carry Linear provenance are flagged `alreadyInLinear: true`.
- **`--push`:** creates the issues in Linear. Only mutates Linear when **both** `--push`
  is set **and** `LINEAR_API_KEY` is present, and requires `--team <slug>` to resolve the
  target team. Items already linked to Linear are skipped so the push is idempotent.

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
| `--dry-run` | boolean | `false` | **Offline** — print the would-be `issueCreate`/`issueUpdate` mutations + variables, no network |

```bash
# Preview the exact Linear mutations that a --push would send (no network)
pm linear export --dry-run --team ENG
```

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

| Linear state type / name | pm status |
|--------------------------|-----------|
| `unstarted` (Todo, Backlog, Triage) | `open` |
| `started` (In Progress, In Review) | `in_progress` |
| `completed` (Done, Completed) | `closed` |
| `cancelled` (Cancelled) | `closed` |
| name contains "blocked" | `blocked` |

A `--status-map "Linear State=pm_status,…"` overrides this heuristic and is
inverted to drive the export/push direction (pm status → Linear state name).

### Item fields

| pm field | Linear source |
|----------|---------------|
| `idSuffix` | `identifier` (e.g. `ENG-123`) |
| `title` | `[ENG-123] Issue title` |
| `body` | `description` |
| `status` | mapped from `state.type` / `state.name` |
| `priority` | mapped from `priority` |
| `tags` | label names |
| `meta.linear_id` | issue UUID |
| `meta.linear_team` | team slug (uppercase) |
| `meta.linear_state` | raw state name |
| `meta.linear_identifier` | e.g. `ENG-123` |
| `meta.due_date` | `dueDate` (if set) |
| `meta.linear_cycle` | cycle name (if set) |

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
