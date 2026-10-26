# Published pm SDK capability floor

Audited main: `f728894ea44cad6ff5b6fc14012d3f17c0e54515`. Required API floor: **2026.8.18**.

Declared host floor: `2026.10.4`. npm peer: `>=2026.10.4`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [index.ts:16](../index.ts#L16) |
| `@unbrained/pm-cli/sdk/runtime :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:1155](../index.ts#L1155) |
| `@unbrained/pm-cli/sdk/runtime :: getSettingsPath` | 2026.5.27 | 2026.5.24 | [index.ts:1843](../index.ts#L1843), [index.ts:1849](../index.ts#L1849) |
| `@unbrained/pm-cli/sdk/runtime :: listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:1200](../index.ts#L1200) |
| `@unbrained/pm-cli/sdk/runtime :: locateItem` | 2026.5.27 | 2026.5.24 | [index.ts:1852](../index.ts#L1852), [index.ts:1865](../index.ts#L1865) |
| `@unbrained/pm-cli/sdk/runtime :: pathExists` | 2026.5.27 | 2026.5.24 | [index.ts:1845](../index.ts#L1845) |
| `@unbrained/pm-cli/sdk/runtime :: PmClient` | 2026.7.6 | 2026.7.5 | [index.ts:1628](../index.ts#L1628) |
| `@unbrained/pm-cli/sdk/runtime :: readSettings` | 2026.5.27 | 2026.5.24 | [index.ts:1626](../index.ts#L1626), [index.ts:1842](../index.ts#L1842) |
| `@unbrained/pm-cli/sdk/runtime :: resolveItemTypeRegistry` | 2026.5.27 | 2026.5.24 | [index.ts:1846](../index.ts#L1846) |
| `@unbrained/pm-cli/sdk/runtime :: resolvePmRoot` | 2026.5.27 | 2026.5.24 | [index.ts:1625](../index.ts#L1625), [index.ts:1902](../index.ts#L1902) |
| `@unbrained/pm-cli/sdk/runtime :: schemaList` | 2026.7.9 | 2026.7.8 | [index.ts:1319](../index.ts#L1319) |
| `@unbrained/pm-cli/sdk/runtime :: writeFileAtomic` | 2026.5.27 | 2026.5.24 | [index.ts:1845](../index.ts#L1845) |
| `CommandHandlerContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:3584](../index.ts#L3584) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:3436](../index.ts#L3436) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:3534](../index.ts#L3534), [index.ts:3537](../index.ts#L3537), [index.ts:3558](../index.ts#L3558), [index.ts:3559](../index.ts#L3559), [index.ts:3560](../index.ts#L3560), [index.ts:3561](../index.ts#L3561), [index.ts:3562](../index.ts#L3562), [index.ts:3563](../index.ts#L3563), [index.ts:3564](../index.ts#L3564), [index.ts:3584](../index.ts#L3584), [index.ts:3590](../index.ts#L3590), [index.ts:3591](../index.ts#L3591), [index.ts:3595](../index.ts#L3595), [index.ts:3635](../index.ts#L3635), [index.ts:3636](../index.ts#L3636), [index.ts:3645](../index.ts#L3645), [index.ts:3646](../index.ts#L3646), [index.ts:3647](../index.ts#L3647), [index.ts:3648](../index.ts#L3648), [index.ts:3649](../index.ts#L3649), [index.ts:3650](../index.ts#L3650), [index.ts:3651](../index.ts#L3651), [index.ts:3652](../index.ts#L3652), [index.ts:3653](../index.ts#L3653), [index.ts:3654](../index.ts#L3654), [index.ts:3655](../index.ts#L3655), [index.ts:3656](../index.ts#L3656), [index.ts:3661](../index.ts#L3661), [index.ts:3746](../index.ts#L3746), [index.ts:3750](../index.ts#L3750), [index.ts:3751](../index.ts#L3751), [index.ts:3771](../index.ts#L3771) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:3457](../index.ts#L3457), [index.ts:3540](../index.ts#L3540), [index.ts:3565](../index.ts#L3565), [index.ts:3677](../index.ts#L3677), [index.ts:3752](../index.ts#L3752) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:3520](../index.ts#L3520), [index.ts:3543](../index.ts#L3543), [index.ts:3602](../index.ts#L3602), [index.ts:3735](../index.ts#L3735), [index.ts:3758](../index.ts#L3758) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:3906](../index.ts#L3906) |
| `ExtensionApi.registerFlags` | 2026.5.1 | 2026.3.12 | [index.ts:3755](../index.ts#L3755), [index.ts:3801](../index.ts#L3801), [index.ts:3817](../index.ts#L3817) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:3829](../index.ts#L3829), [index.ts:4117](../index.ts#L4117) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:3793](../index.ts#L3793) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:3581](../index.ts#L3581) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:3830](../index.ts#L3830), [index.ts:3831](../index.ts#L3831), [index.ts:3840](../index.ts#L3840), [index.ts:3841](../index.ts#L3841), [index.ts:3842](../index.ts#L3842), [index.ts:3843](../index.ts#L3843), [index.ts:3844](../index.ts#L3844), [index.ts:3845](../index.ts#L3845), [index.ts:3846](../index.ts#L3846), [index.ts:3847](../index.ts#L3847), [index.ts:3848](../index.ts#L3848), [index.ts:3849](../index.ts#L3849), [index.ts:3850](../index.ts#L3850), [index.ts:3851](../index.ts#L3851), [index.ts:3856](../index.ts#L3856), [index.ts:3907](../index.ts#L3907), [index.ts:3908](../index.ts#L3908), [index.ts:3909](../index.ts#L3909), [index.ts:3911](../index.ts#L3911), [index.ts:3913](../index.ts#L3913), [index.ts:3915](../index.ts#L3915), [index.ts:4122](../index.ts#L4122), [index.ts:4123](../index.ts#L4123), [index.ts:4135](../index.ts#L4135), [index.ts:4136](../index.ts#L4136), [index.ts:4137](../index.ts#L4137), [index.ts:4138](../index.ts#L4138), [index.ts:4139](../index.ts#L4139), [index.ts:4140](../index.ts#L4140), [index.ts:4141](../index.ts#L4141), [index.ts:4142](../index.ts#L4142), [index.ts:4143](../index.ts#L4143), [index.ts:4144](../index.ts#L4144), [index.ts:4149](../index.ts#L4149) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:3872](../index.ts#L3872), [index.ts:3916](../index.ts#L3916), [index.ts:4170](../index.ts#L4170) |
| `PmClient.notes` | 2026.7.9 | 2026.7.8 | [index.ts:1629](../index.ts#L1629), [index.ts:1657](../index.ts#L1657) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.24 | `9d28fff4b06405ea5691ee919ad646c86c0a416a5007ca8104b19251306262af` |
| 2026.5.27 | `afd3c6e0ecca429510f049019069802c0034a3e99fb711035b5b22fc8fa643dd` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.9 | `87600f77a82d5e66c8ac05f120b435a0fb22b5fad42ae5db4540bb4ca45a01ea` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |

PR #175 changed only tracker files, SDK-adoption audit documentation, and the differential test; its merge added no runtime code. This inventory also covers runtime changes already present on the audited main.
