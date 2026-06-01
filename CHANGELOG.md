# Changelog

## Unreleased

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
