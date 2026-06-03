# Changelog

## Unreleased

### Added

- Deep enhancement: offline dry-run plans, --map field mapping, validate diagnostics, push-on-write hook ([pm-linear-oa21](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-oa21.toon))
- Unit tests for new pure fns + README + manifest capability review + release ([pm-linear-ced8](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-ced8.toon))

## 2026.06.03 - 2026-06-03

### Added

- SDK-capability enhancement: idempotent sync, preflight, bidirectional status mapping, export updates ([pm-linear-ikwo](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-ikwo.toon))

### Changed

- Idempotent import: update existing pm items matched on linear\_id ([pm-linear-xp5j](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-xp5j.toon))
- Exporter update + bidirectional status mapping + dry-run ([pm-linear-75yf](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-75yf.toon))

### Fixed

- Fix unusable --no-preflight-network escape hatch on sync \(declare flag\) ([pm-linear-n0e7](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-n0e7.toon))

### Other

- Production-readiness audit 2026-05-28 ([pm-linear-usug](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-usug.toon))
- Tests + functional fixtures + manifest/README ([pm-linear-swdk](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-swdk.toon))
- preflight capability: validate LINEAR\_API\_KEY + API reachability ([pm-linear-u8ed](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-u8ed.toon))
- HTTP robustness: timeout + rate-limit/429 backoff retry ([pm-linear-cj68](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-cj68.toon))
- Import filters: assignee + label GraphQL filter clauses ([pm-linear-rnf2](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-rnf2.toon))
- linear validate diagnostics command \(--json, no secret leak\) ([pm-linear-l2oo](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-l2oo.toon))
- Field-mapping depth + generic --map linearField=pmField \(pure, both directions\) ([pm-linear-1pl0](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-1pl0.toon))
- Offline --dry-run: build+print GraphQL query/variables + export mutations, no network ([pm-linear-6u39](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-6u39.toon))
- Push-on-write hook \(opt-in, hooks capability\) mirroring pm writes to Linear ([pm-linear-wp4n](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-wp4n.toon))
- Step 0: verify activation healthy \(doctor deep, command run, missing-creds clean\) ([pm-linear-40k5](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-40k5.toon))

## 2026.06.02 - 2026-06-02

### Added

- Adopt full SDK capability surface \(linear importer/exporter + schema fields + flags\) ([pm-linear-du0a](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-du0a.toon))

## 2026.06.01 - 2026-06-01

### Fixed

- linear sync threw plain Error \(no exitCode\) → runtime double-invocation ([pm-linear-sn60](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-sn60.toon))

## 2026.05.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-linear-kj99](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/features/pm-linear-kj99.toon))

### Fixed

- issues with dueDate use --due-date which pm create rejects \(exit 2\) ([pm-linear-hyc6](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-hyc6.toon))
- no GraphQL pagination: --limit \> 250 silently truncates ([pm-linear-92kd](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-92kd.toon))
- sync failures return {success:false} instead of throwing -\> exit 0 ([pm-linear-da0d](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-da0d.toon))
- dry-run/limit flags read kebab keys; --dry-run silently writes ([pm-linear-g30q](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/issues/pm-linear-g30q.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-linear-iowz](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-iowz.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-linear-fwwx](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-fwwx.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-linear-wnw3](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-wnw3.toon))

### Other

- Release readiness hardening for pm-linear ([pm-linear-fdc8](https://github.com/unbraind/pm-linear/blob/main/.agents/pm/tasks/pm-linear-fdc8.toon))
