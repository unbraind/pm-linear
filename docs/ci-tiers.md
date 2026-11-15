# Fleet CI v2

Required checks stay `test (22)` and `test (26)`. PRs and dispatch use hosted
runners, deterministic quick seed prefixes, cancellation and 30 minute job caps.
Deep runs on main pushes, dispatch and nightly 02:43 UTC, separate from release
cron minutes 23/41. Four distinct Node 22/26 × npm/Bun jobs each run one full gate
with a 120 minute timeout and PM_TEST_TIME_SCALE=3. Local runners use persistent
npm cache and preinstalled Bun (version logged); hosted fallback is controlled
by PM_LOCAL_DEEP=off. Per-ref concurrency cancels superseded deep runs.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker (both) | Deep each leg |
| --- | --- | --- | --- | --- |
| npm ci and prepare | yes | yes | yes | yes |
| Strict pm health / merge drivers | — | yes | yes | yes |
| Build / tests | quick | quick coverage | README result-contract suite | full |
| Typecheck / docstrings | — | yes | — | yes |
| Coverage: lines 99, branches 96, functions 100 (unchanged) | — | quick | — | full |
| Production audit | — | yes | — | yes |
| Pack dry run (includes README/changelog) | — | yes | yes | yes |
| Changelog consistency / tracker-derived date verifier | — | yes | yes | yes |
| Publish attestation verifier | via tests | yes | — | yes |
| Identity audit | via tests | via tests | yes | via tests |
| Bun graph install | — | yes | — | yes |
| Bun built-module import / bunx pinned installed CLI smoke | — | yes | — | — |
| CodeQL (not required) | separate workflow | separate workflow | filtered | main code paths and unchanged weekly scan |

No old gate check is dropped. No lint script exists. The docs path retains
README-dependent sync-result-contract tests, commit identity, packing, changelog
and the date verifier, which reads tracker data. Full historical and native size
boundary fixtures remain unchanged. Quick runs the same first 50 of each 500
case corpus; the grouped estimate model retains original group sizes and stops
after the deterministic prefix. Route thresholds use the generated count;
refusal/admission counters start at zero. No coverage exclusions or thresholds change.

Existing standalone ownership/estimate packed acceptance scripts exercise npm,
Bun/global and bunx, but the original release gate does not invoke those scripts.
The PR tier therefore explicitly smokes Bun module loading and bunx CLI resolution
from the installed pinned host, without claiming new packed acceptance coverage.
Harness deadlines validate a finite positive scale before child launch and round
up milliseconds. Product network request deadlines and their assertions remain
unscaled. Full local depth is deliberately not run on the overloaded host.

Owner fleet baseline: 39,929 runner-minutes in 24 h; median PR CI 45–90 minutes,
about 28 minutes queueing. New quick/full timing comparison and final PR wall
measurement remain pending. Supersedes #224, which stays open.
Companion: pm-cli-website-dyhg.
