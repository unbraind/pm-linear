# pm-linear

Linear.app issue sync extension for [pm-cli](https://github.com/unbraind/pm-cli).

Fetches issues from a Linear team and upserts them as pm items, keeping identifiers, priorities, estimates, statuses, labels, due dates, assignees, cycles, customer names, and project names in sync. Also provides a native import pipeline (`pm linear import`) and an exporter (`pm linear export`) that renders pm items as Linear issue-create payloads, and declares `linear_id` / `linear_url` provenance fields.

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

- pm-cli `>=2026.7.5`
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
| `--cycle` | string | — | Filter by cycle name (e.g. `"Sprint 7"`, `"Q3"`); case-insensitive substring match, issues with no cycle are excluded |
| `--assignee` | string | — | Filter by assignee email |
| `--label` | string | — | Filter by label name |
| `--updated-since` | string | — | Only issues updated at/after an ISO date or duration (e.g. `2026-01-01`, `-P7D`) |
| `--status-map` | string | — | Override status mapping, e.g. `"In Review=in_progress,Backlog=open"` |
| `--map` | string | — | Remap Linear→pm fields, e.g. `"identifier=ignore,priority=ignore"` |
| `--project-map` | string | — | Tag items by Linear project name (additive). Bare flag tags with the verbatim name; `"Mobile=mobile,Web=web"` remaps |
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
| type `completed` / `cancelled` | `closed` |
| name contains "in progress" / "in review" | `in_progress` |
| name contains "blocked" | `blocked` |
| name contains "done" / "completed" / "cancelled" | `closed` |
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
Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.
