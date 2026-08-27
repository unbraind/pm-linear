# Changelog

## 2026.8.27 - 2026-08-27

### Fixed

- changelog scripts read the pm workspace with default budgets instead of canonical complete reads ([pm-linear-4so4](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-4so4.toon))

### Security

- The identity gate deadlocks the one remediation its own failure message prescribes ([pm-linear-ofoe](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-ofoe.toon))

### Other

- Drop inert pm manifest key and guard the closed manifest vocabulary ([pm-linear-ck8r](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-ck8r.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- A globally-scoped preflight override collides with every other installed package, so pm health can never be green ([pm-linear-hwol](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-hwol.toon))

### Deprecated

- The deprecated linear-sync importer alias loses its credential gate when the preflight override is scoped ([pm-linear-ydo4](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-ydo4.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- The shared script launcher skipped every gate it guarded when a path could not be resolved ([pm-linear-lonp](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-lonp.toon))
- Converge changelog generation and verification on replace mode ([pm-linear-semp](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-semp.toon))
- The release merge-wait queried branch protection, which the workflow token can never read ([pm-linear-0u8d](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-0u8d.toon))

## 2026.8.9 - 2026-08-09

### Fixed

- Release workflow publishes to npm before advancing protected main, desyncing npm from git ([pm-linear-j7oc](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-j7oc.toon))
- Adopt the canonical pm-ops docstring gate and document all source declarations ([pm-linear-085x](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-085x.toon))

### Other

- Reconcile git main to the 2026.8.9 release npm already serves ([pm-linear-33nf](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-33nf.toon))

## 2026.8.7 - 2026-08-07

### Other

- Gate CI on strict tracked pm project health ([pm-linear-9848](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-9848.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-linear-hrda](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-hrda.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-linear-v618](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-v618.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-linear-vp1l](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-vp1l.toon))

## 2026.7.28 - 2026-07-28

### Other

- Adopt pm-cli 2026.7.28 and migrate activation tests to the real SDK harness ([pm-linear-itg9](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-itg9.toon))
- Eliminate all source any with real Linear GraphQL and SDK handler types ([pm-linear-pfmo](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-pfmo.toon))
- Adopt pm-cli 2026.7.27 ([pm-linear-zntu](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-zntu.toon))

## 2026.7.27 - 2026-07-27

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-linear-9j2g](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-9j2g.toon))

## 2026.7.26 - 2026-07-26

### Fixed

- Documented install command fails: pm install github.com/unbraind/pm-linear cannot resolve an entry file ([pm-linear-ga1c](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-ga1c.toon))

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-linear-0iye](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-0iye.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-linear-ge9y](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-ge9y.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-linear-3ifi](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-3ifi.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-linear-1llj](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-1llj.toon))

## 2026.7.21 - 2026-07-21

### Added

- Add opt-in --atomic to linear import/sync via SDK commitItemMutations ([pm-linear-nvt5](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-nvt5.toon))

## 2026.7.11 - 2026-07-11

### Added

- Full pm ecosystem production pass for pm-linear ([pm-linear-p6lk](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-p6lk.toon))

### Fixed

- state filter is applied client-side after --limit, under-returning on large teams ([pm-linear-zczw](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-zczw.toon))

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-linear-oe0z](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-oe0z.toon))
- Full-cycle hardening wave: pm-linear ([pm-linear-co77](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-co77.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-linear-hqip](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-hqip.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-linear-g7jd](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-g7jd.toon))
- Regenerate CHANGELOG after pm close item ([pm-linear-jixz](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-jixz.toon))

## 2026.6.9 - 2026-06-09

### Added

- Round-trip Linear estimate and cycle on export ([pm-linear-2xj5](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-2xj5.toon))

## 2026.6.7 - 2026-06-07

### Added

- Import Linear estimate and customer context tags ([pm-linear-82dn](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-82dn.toon))

### Other

- Harden release readiness checks ([pm-linear-rrsg](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-rrsg.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-linear-eehh](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/chores/pm-linear-eehh.toon))

## 2026.6.5 - 2026-06-05

### Fixed

- Persist Linear assignee+cycle on import, fix --status-map export-preview casing, isolate per-item export-push failures ([pm-linear-lkhf](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-lkhf.toon))

## 2026.6.4 - 2026-06-04

### Added

- Export priority/labels/dueDate + --project-map import tagging ([pm-linear-g0c1](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-g0c1.toon))

## 2026.6.3-1 - 2026-06-03

### Added

- Deep enhancement: offline dry-run plans, --map field mapping, validate diagnostics, push-on-write hook ([pm-linear-oa21](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-oa21.toon))
- Unit tests for new pure fns + README + manifest capability review + release ([pm-linear-ced8](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-ced8.toon))

## 2026.6.3 - 2026-06-03

### Added

- SDK-capability enhancement: idempotent sync, preflight, bidirectional status mapping, export updates ([pm-linear-ikwo](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-ikwo.toon))

### Changed

- Idempotent import: update existing pm items matched on linear_id ([pm-linear-xp5j](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-xp5j.toon))
- Exporter update + bidirectional status mapping + dry-run ([pm-linear-75yf](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-75yf.toon))

### Fixed

- Fix unusable --no-preflight-network escape hatch on sync (declare flag) ([pm-linear-n0e7](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-n0e7.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-linear-usug](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-usug.toon))
- Tests + functional fixtures + manifest/README ([pm-linear-swdk](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-swdk.toon))
- preflight capability: validate LINEAR_API_KEY + API reachability ([pm-linear-u8ed](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-u8ed.toon))
- HTTP robustness: timeout + rate-limit/429 backoff retry ([pm-linear-cj68](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-cj68.toon))
- Import filters: assignee + label GraphQL filter clauses ([pm-linear-rnf2](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-rnf2.toon))
- linear validate diagnostics command (--json, no secret leak) ([pm-linear-l2oo](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-l2oo.toon))
- Field-mapping depth + generic --map linearField=pmField (pure, both directions) ([pm-linear-1pl0](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-1pl0.toon))
- Offline --dry-run: build+print GraphQL query/variables + export mutations, no network ([pm-linear-6u39](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-6u39.toon))
- Push-on-write hook (opt-in, hooks capability) mirroring pm writes to Linear ([pm-linear-wp4n](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-wp4n.toon))
- Step 0: verify activation healthy (doctor deep, command run, missing-creds clean) ([pm-linear-40k5](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-40k5.toon))

## 2026.6.2 - 2026-06-02

### Added

- Adopt full SDK capability surface (linear importer/exporter + schema fields + flags) ([pm-linear-du0a](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-du0a.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- linear sync threw plain Error (no exitCode) → runtime double-invocation ([pm-linear-sn60](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-sn60.toon))

## 2026.5.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-linear-kj99](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-kj99.toon))

### Fixed

- issues with dueDate use --due-date which pm create rejects (exit 2) ([pm-linear-hyc6](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-hyc6.toon))
- no GraphQL pagination: --limit \> 250 silently truncates ([pm-linear-92kd](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-92kd.toon))
- sync failures return {success:false} instead of throwing -\> exit 0 ([pm-linear-da0d](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-da0d.toon))
- dry-run/limit flags read kebab keys; --dry-run silently writes ([pm-linear-g30q](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-g30q.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-linear-iowz](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-iowz.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-linear-fwwx](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-fwwx.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-linear-wnw3](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-wnw3.toon))

### Other

- Release readiness hardening for pm-linear ([pm-linear-fdc8](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-fdc8.toon))
