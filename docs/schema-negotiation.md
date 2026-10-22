# Versioned Linear mapping example

```ts
import {
  negotiateLinearSchema, syncLinearIssues, LinearSchemaRefusal,
  type LinearSchemaOptions,
} from "pm-linear";

// The caller supplies an existing tracker root; no git repository is required.
const mapping: LinearSchemaOptions = {
  team: "ENG", statusMap: { Review: "in_progress" },
};

/** Discover a read-only report to persist and review before a later apply. */
export async function discoverTeamSchema(pmRoot: string) {
  return negotiateLinearSchema(mapping, pmRoot);
}

/** Apply only the version that the caller has already persisted and reviewed. */
export async function importReviewedTeam(pmRoot: string, reviewedSchemaVersion: string) {
  try {
    return await syncLinearIssues({
      ...mapping, schemaVersion: reviewedSchemaVersion, limit: 100, atomic: true,
    }, pmRoot);
  } catch (error: unknown) {
    if (error instanceof LinearSchemaRefusal) {
      return { refused: true, code: error.code, remedy: error.remedy };
    }
    throw error;
  }
}
```

First call `discoverTeamSchema(pmRoot)`, persist the returned report and review
its mapping. In a separate apply invocation, pass the saved `schemaVersion` to
`importReviewedTeam(pmRoot, reviewedSchemaVersion)`. The apply function does not
replace that reviewed value with a freshly discovered version; drift returns a
typed refusal instead of silently approving a new mapping.

The report deliberately omits issue content and the full label catalog. Labels
map by name to pm tags. The label digest/version binds both IDs and names, so a
replacement label with the same name also invalidates a saved version. Explicit
state mappings must refer to existing provider states and registered local pm
statuses. Custom pm statuses come from `schemaList`; this package does not create
or migrate pm schema definitions.

The underlying read operations and permission model are documented in the
[Linear GraphQL guide](https://linear.app/developers/graphql) and
[API key permissions](https://linear.app/docs/api-and-webhooks).
Metadata field names and filters were checked against Linear's
[published GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
The CI runtime matrix follows [GitHub's matrix contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations).

## Validation procedure

Use an archive of the public fleet tracker's committed `.agents/pm` tree in a
scratch directory outside git. Read it using `PmClient` with `noExtensions: true`
and `listAllComplete({ includeBody: true })`. Certify and preview against that
whole corpus. Derive synthetic workflow states from its actual status registry
and synthetic labels from its actual tags, and serve these through a loopback
GraphQL fixture. This tests real local content without requiring a Linear account
or disclosing any credentials. It is not live Linear service acceptance.

Make the copied source files read-only, remove git from PATH and set the git
ceiling to the scratch parent. Negotiate, run an atomic dry-run, then repeat
with deleted-label, renamed-state and denied-permission controls. Compare all
copied source bytes before and after. Never apply a sync to this evidence copy.

The regression suite additionally initializes real temporary SDK trackers and
runs with a PATH containing no git executable. It checks custom local statuses,
independent state/label pagination, malformed/partial responses, duplicate IDs,
repeated cursors, metadata changes during issue fetch, both writer paths, and
schema-version forwarding through sync and both importer surfaces.

## Measured public-tracker acceptance

[Machine-readable measurement receipt](schema-negotiation-validation.json).

Source: `unbraind/pm-linear` main commit
`7f2473765ca6a1fd5e479a990f37ea9ab38cbb2e`, copied before this feature's pm item.

| Measurement | Result |
| --- | ---: |
| Certified real pm items | 100 |
| Copied source files hashed before/after | 208 |
| Actual statuses represented | 6 |
| Distinct real tag names represented as fixture labels | 66 |
| Existing status counts | 7 open, 5 in progress, 1 blocked, 86 closed, 1 canceled |
| Atomic preview | 100 creates, 0 updates, 0 writes |
| Compact report | 946 JSON bytes / 733 TOON bytes |
| Metadata requests / issue requests | 6 / 1 |
| Changed copied source files | 0 |
| Negotiation, preview and three negative controls | 620 ms initial / 2,120 ms after mapper correction |

The synthetic deleted-label control refused with `schema_drift`; the synthetic
renamed-state control refused with `mapping_invalid` because its explicit old
state override no longer existed; the denied-permission control refused with
`access_denied`. All three refused before an issue request/local change. No live
Linear credentials or live Linear account were used. SDK runtime caches may be
created outside the set of copied source artifacts.

Aggregate SHA-256 of the copied source names and bytes before and after:
`67049e730b26c6b6983aa71da60632ad9eb57df2693a52d8d5155ed37677aae1`.

Behavioral revert proof: disabling only the negotiated-version comparison made
both deleted-label and renamed-state regressions fail (2/2). Restoring it and
disabling only sync's metadata negotiation made both GraphQL-denial and hidden-team
regressions fail (2/2). The production functions were restored after each probe.

The shared status mapper also recognizes Linear's canonical `canceled` and
`duplicate` workflow types as closed, retaining the legacy `cancelled` spelling.
All three canonical/fallback regressions pass; reverting only the mapper makes
all three fail. Resolved mappings participate in schema versions, so a future
mapper behavior change invalidates old reports even with identical metadata.

## Full implementation gates

[CI run 39807792715](https://github.com/unbraind/pm-linear/actions/runs/39807792715)
passed on implementation commit `4a6758f8e4170ce51e6dfb71b8ca8a7370dd5f7d`:

| Job | Passed tests | Failed tests |
| --- | ---: | ---: |
| `npm run release:check` | 323 | 0 |
| `bun run release:check` | 323 | 0 |
| Node 22 CI checks | 323 | 0 |
| Node 26 CI checks | 323 | 0 |

The npm/Bun gates each measured 99.69% lines, 96.90% branches and 100% functions
over the package source, exceeding the unchanged 99/96/100 thresholds. Both
production dependency audits found zero vulnerabilities. Type checking,
docstrings, package contents, changelog/date and publish attestation passed.
Both fresh-checkout health checks passed, although local strict health reported
host-specific extension version skew and inherited merge-fence differences.
The latest PR checks also cover the final evidence/claim-release commit.

## Review-round verification

The reviewed-apply example is executed directly from this page against a real
no-git tracker, proving that a saved version cannot be replaced by fresh
discovery. Endpoint validation retains only the two fixed safe diagnostics;
arbitrary response errors and configured query values remain redacted. All
four digest-input sorts use UTF-16 code-unit ordering; actual English/Swedish
Node processes agree on reports with Unicode metadata and SDK-created statuses.

Behavioral reverts fail as expected: example apply function 1/1, schema
negotiation endpoint handling 2/2, schema negotiation ordering 1/1, and local
status reader ordering separately 1/1. Restored review controls pass 5/5, and
the complete linked schema suite passes 52/52.

[Review-fix CI run 39825310519](https://github.com/unbraind/pm-linear/actions/runs/39825310519)
passed on `c430b7e0c49acbf5fef9c96bb7280b27382e0476`: npm and Bun full release
gates plus Node 22/26 checks each passed 328/328 tests. Source coverage measured
99.69% lines, 97.05% branches and 100% functions at unchanged 99/96/100
thresholds. Package/audit/changelog/date/attestation checks passed. The latest
PR checks cover the subsequent evidence-only commit as well.
