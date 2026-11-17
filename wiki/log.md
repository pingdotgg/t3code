# Wiki update log

## 2026-11-17

- **Integration candidate**: [Upstream integration](upstream-integration.md#november-17-candidate) records merge `423f20588f` through `a99faf5a62`, retaining all 201 incoming commits with zero branch gap. Fork `main` remains at `38ba9f1c7a`. Recovery keeps upstream's empty-directory fix alongside Git/Jujutsu ownership; the overlapping PR action stays a single implementation. No live deployment occurred.

- **Compatibility**: Recorded [PR #83](https://github.com/NicholasZolton/t3code/pull/83)'s [opt-in PR approval wait](upstream-integration.md#opt-in-pull-request-approval-waits). Default watches retain upstream's checks-only waiting; `waitForApproval` also waits for a host-reported approval and releases automatically without unwatching.

## 2026-11-16

- **Integration**: [PR #81](https://github.com/NicholasZolton/t3code/pull/81) reached fork `main` at `eda7ca8f3f`. Refreshed [upstream integration](upstream-integration.md#completed-november-16-sync): all 967 incoming commits through `c8c51af4e3` are incorporated with ancestry preserved and zero main gap. Verification passes 17,582 tests after fixture repairs; all 19 remaining failures reproduce on pristine upstream or fork main. Upstream folder matching replaces the overlapping fork implementation, while shared Git/Jujutsu PR routing and OpenCode input-delivery safeguards remain. Native clients remain unverified; no live deployment occurred.

## 2026-11-15

- **Permissions**: Removed the fork's [OpenCode permission override](upstream-integration.md#opencode-compatibility-boundary); upstream thread-controlled modes now apply on session creation, resume, child setup, and rollback.

- **Retirement**: Removed the [Tricket integration](tricket-integration.md) and restored pre-integration code paths. Existing threads, connector data, and credentials are not deleted; deployed runtimes require a separate update.

## 2026-11-14

- **Tricket**: Corrected native execution to use thread-bound MCP for leads and workers, with full-access defaults for unattended work; opt-in ordinary threads kept their existing permissions and CLI-only exposure. [Retired November 15](tricket-integration.md).

- **Tricket**: Recorded project leads and opt-in CLI enrollment: execute the brief only when instructed, keep existing threads and credentials, and avoid adding MCP context to ordinary agents. New assignment records stayed isolated from the legacy ticket worker table for safe runtime rollback. [Retired November 15](tricket-integration.md).

## 2026-11-13

- **Tricket**: Corrected the native integration record: PR #76 merged and its initial assignment path was deployed. Recorded the follow-up boundary: replay committed activity into the same owner, suppress only its own actor, preserve snooze, and count active turns rather than open tickets. [Retired November 15](tricket-integration.md).

- **Integration**: [PR #75](https://github.com/NicholasZolton/t3code/pull/75) reached fork `main` at `8843960553`. Refreshed [upstream integration](upstream-integration.md#completed-november-13-sync): all 379 commits through `286eeea19f` are incorporated with ancestry preserved and zero main gap. Partitioned verification passes 12,901 tests; remaining failures reproduce on pinned upstream or fork main. Shared Git/Jujutsu recovery, process-aware OpenCode recovery, quota weighting, and launch/update fallbacks remain. No live deployment occurred.

## 2026-11-12

- **Compatibility**: Recorded the fork-only [Default app item](upstream-integration.md#default-app-in-the-open-in-picker) in the Open-in picker. Upstream offers only editors and the file manager.

- **Integration**: [PR #73](https://github.com/NicholasZolton/t3code/pull/73) reached fork `main` at `fee9ab51a2`. Refreshed [upstream integration](upstream-integration.md#completed-november-12-sync): all 507 commits through `371963ce0b` are incorporated with ancestry preserved and zero main gap. Of 1,033 incoming paths without prior fork changes, only the project MCP clone fixture differs from upstream. The broad selection passes 11,726 tests; remaining timing, host `/tmp`, and native verification limitations are recorded on the PR. No live deployment occurred.

## 2026-11-11

- **Integration**: [PR #72](https://github.com/NicholasZolton/t3code/pull/72) reached fork `main` at `0187eabf9e`. Refreshed [upstream integration](upstream-integration.md#completed-november-11-sync): all 161 incoming commits through `1d152c3df4` are incorporated with ancestry preserved and zero main gap. All 644 incoming paths without prior fork changes match upstream. Selected tests pass 9,449 cases; remaining browser and quota failures reproduce on pristine upstream or fork main. Native verification remains blocked by device-hub startup. No live deployment occurred.

## 2026-11-10

- **Compatibility**: [OpenCode limits](upstream-integration.md#opencode-compatibility-boundary) now restore the selected Codex subscription through OpenCode's API and the shared Limits view, without restoring credential-file reads, account switching, or token-refresh ownership.

- **Integration**: [PR #71](https://github.com/NicholasZolton/t3code/pull/71) reached fork `main` at `abb6f0b72a`. Refreshed [upstream integration](upstream-integration.md#completed-november-10-sync): all 114 commits through `8ee7183e6c` are incorporated with ancestry preserved and zero main gap. The SSH guard now covers live sibling-launch records. Four test failures reproduce on pristine upstream; native device verification remains blocked. No live deployment occurred.

## 2026-11-09

- **Follow-up integration**: [PR #69](https://github.com/NicholasZolton/t3code/pull/69) reached fork `main` at `7a0869df09`. Refreshed [upstream integration](upstream-integration.md#completed-november-9-follow-up): all 48 newer commits through `7b248349bd` are incorporated with ancestry preserved and zero main gap. Three browser failures reproduce on clean upstream; native verification remains blocked by device-hub startup. No live deployment occurred.

- **Integration**: [PR #68](https://github.com/NicholasZolton/t3code/pull/68) reached fork `main` at `2d55bfc6f4`. Refreshed [upstream integration](upstream-integration.md#completed-november-9-sync): all 95 incoming commits through `5ee1dbffbe` are incorporated with ancestry preserved and zero main gap. Copilot's file limit prevented review; local verification and gaps are recorded on the PR. No live deployment occurred.

- **Local branch integration**: [Upstream integration](upstream-integration.md#completed-november-9-sync) initially recorded merges `fcf161aee5` and `e5f32987d0` through upstream `5ee1dbffbe`, with all 95 incoming commits present on the branch while fork `main` remained at `19474d8c52`. Of 545 incoming paths without prior fork changes, only two mobile test fixtures differ from upstream. PR #68 subsequently closed that main gap.

## 2026-11-07

- **Compatibility**: Recorded the fork-only [searchable All projects row](upstream-integration.md#searchable-all-projects-row) in the sidebar project filter. Upstream hides it while a search query is typed.

- **Correction**: Composer scroll-collapse was upstream's, not fork behavior. Upstream removed it, so the fork drops it too; [upstream integration](upstream-integration.md#completed-november-2-sync) no longer lists it as retained.

- **Compatibility**: Recorded the fork-only [Tailscale IPv4 check for linked environments](upstream-integration.md#tailscale-ipv4-addresses-for-linked-environments). A server may now link to a machine at a Tailscale IPv4 address that its own Tailscale lists.

- **Remote deployment target**: Nicholas's remote server is now `nicholas-dev`, a `t3 up` boot service. [Upstream integration](upstream-integration.md#ssh-runtime-release-handoff) notes that the SSH deployment helper does not apply there and points to the service procedure in `AGENTS.md`.

- **Compatibility**: Recorded the fork-only [fnox secrets for provider processes](upstream-integration.md#fnox-secrets-for-provider-processes) startup step, which upstream syncs must keep next to `fixPath`.

- **Integration**: [PR #59](https://github.com/NicholasZolton/t3code/pull/59) reached fork `main` at `703297e186`. Refreshed [upstream integration](upstream-integration.md#completed-november-7-sync): all 277 incoming commits through `e455200077` are incorporated with ancestry preserved and zero main gap. Remote deployment remains separate.

- **Local branch integration**: [Upstream integration](upstream-integration.md#local-november-7-sync) records merge `6087079d9d` through upstream `e455200077`, incorporating all 277 incoming commits with zero branch gap; adaptations through `69a4603d98` retain that merge. Fork `main` remains at `c0bde3fa70` with those commits pending. Jujutsu branch checks must stay one command, and paired notifications keep a set of covered finishes. No main integration, packaging, or deployment has occurred.

## 2026-11-05

- **Integration**: [PR #56](https://github.com/NicholasZolton/t3code/pull/56) reached fork `main` at `53b9557983`. Refreshed [upstream integration](upstream-integration.md#completed-november-5-sync): all 49 incoming commits through `67eebaca23` are incorporated with ancestry preserved and zero main gap. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Local branch integration**: [Upstream integration](upstream-integration.md#completed-november-5-sync) initially recorded merge `1c01e0f4ca` and compatibility repairs through `cc28dd5595`, incorporating all 49 incoming commits through `67eebaca23` with zero branch gap. At that observation, fork `main` remained at `9bcf77bb70` with those commits pending; no push, packaging, deployment, or live-server restart had occurred.

## 2026-11-04

- **Integration**: [PR #55](https://github.com/NicholasZolton/t3code/pull/55) reached fork `main` at `0406c1c1be`. Refreshed [upstream integration](upstream-integration.md#completed-november-4-sync): all 351 incoming commits through `3368dd70f2` are incorporated with ancestry preserved and zero main gap. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Scope reduction**: [OpenCode compatibility boundary](upstream-integration.md#opencode-compatibility-boundary) now retires the fork-only OpenCode account/quota views and switching RPCs in favor of upstream Usage and native Codex workflows. General quota weighting and unrelated OpenCode provider safeguards remain.

- **Local branch integration**: [Upstream integration](upstream-integration.md#completed-november-4-sync) initially recorded merge `865f3f9770` through upstream `3368dd70f2`, with all 351 newer commits incorporated and zero branch gap. Adaptations through `9b7bee668b` use upstream crypto and mobile settings-menu APIs while retaining unreplaced fork boundaries. At that observation, fork `main` remained at `470e518f77` with the same gap pending; no push, packaging, deployment, or live-server restart had occurred.

- **Service configuration**: [Paired Android notifications](paired-notifications.md) now preserve the preview Google services JSON contents in fnox with a temporary-file binding, removing the main-checkout path dependency. Existing Firebase server credentials and private signing identities remain unchanged.

- **Compatibility boundary**: [Paired Android notifications](paired-notifications.md) must remain reachable from mobile Settings without T3 Connect configuration. Recorded the local-only menu entry lost during the November upstream integration and its regression coverage.

## 2026-11-02

- **Integration**: [PR #52](https://github.com/NicholasZolton/t3code/pull/52) reached fork `main` at `9a73f5dd04`. Refreshed [upstream integration](upstream-integration.md#completed-november-2-sync): all 3,337 incoming commits through `dd6c05ec31` are incorporated with ancestry preserved and zero main gap. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Local branch integration**: [Upstream integration](upstream-integration.md#completed-november-2-sync) initially recorded merge `ed52b86b6a` through upstream `dd6c05ec31`, retaining reused merge `e7d7a393d9` and all 3,337 incoming commits with zero branch gap. Follow-up repairs through `1a21e4d0e6` preserved that merge hash. At that observation, fork `main` remained at `c98f21e930` with the same gap still pending. Upstream owns thread ranking and shared client/workflow boundaries; unreplaced fork behavior remains. Nothing had been pushed, packaged, deployed, or restarted.

## 2026-10-16

- **Signing identity**: Recorded the persistent [local macOS signing certificate](local-macos-signing.md), its fnox-backed build command, and the requirement to preserve it across rebuilds and upstream syncs. Apple release signing and the Android keystore remain separate.

- **Integration**: [PR #50](https://github.com/NicholasZolton/t3code/pull/50) reached fork `main` at `d3b3491750`. Refreshed [upstream integration](upstream-integration.md): all 96 incoming commits through `3962ae8586` are incorporated with ancestry preserved and zero gap against the pinned tip. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Branch integration**: [Upstream integration](upstream-integration.md#completed-october-16-sync) initially recorded local merge `837d227b91` through upstream `3962ae8586`, incorporating all 96 incoming commits with zero branch gap. At that observation, fork `main` remained at `f2d43354c9`. Adopted upstream Beta branding, mobile UI boundaries, provider fixes, live command output, and database maintenance while retaining unreplaced fork features. No push, main integration, or remote deployment had occurred.

## 2026-10-15

- **Integration**: [PR #48](https://github.com/NicholasZolton/t3code/pull/48) reached fork `main` at `9ce8f0a504`. Refreshed [upstream integration](upstream-integration.md): all 106 incoming commits through `e536bfd33b` are incorporated with ancestry preserved and zero gap against the pinned tip. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Branch integration**: [Upstream integration](upstream-integration.md#completed-october-15-sync) initially recorded local merge `30b7fbff81` through upstream `e536bfd33b`, with all 106 incoming commits incorporated and zero branch gap. At that observation, fork `main` remained at `e9e7b07c0d`. Upstream now owns managed SSH recovery; the smaller external/discovered readiness guards and unreplaced fork features remain. No push, main integration, or remote deployment had occurred.

## 2026-10-14

- **Integration**: [PR #47](https://github.com/NicholasZolton/t3code/pull/47) reached fork `main` at `65729a4646`. Refreshed [upstream integration](upstream-integration.md): all 42 incoming commits through `6002c5c68c` are incorporated with upstream ancestry preserved and zero gap against the pinned tip. The main local checkout is fast-forwarded; remote deployment remains separate.

- **Branch integration**: [Upstream integration](upstream-integration.md#completed-october-14-sync) initially recorded local merges `24ab07ed90` and `2f17f4f635` through upstream `6002c5c68c`, with all 42 newer commits incorporated and zero branch gap. At that observation, fork `main` remained at `1a005f7db3`; upstream's web settings-write detection replaced the overlapping fork check while mobile warnings and unreplaced fork behavior remained. No push, main integration, or remote deployment had occurred.

## 2026-10-13

- **Integration**: [PR #46](https://github.com/NicholasZolton/t3code/pull/46) reached fork `main` at `eb4dc2fd6e`. Refreshed [upstream integration](upstream-integration.md): all 48 incoming commits through `5070a83a32` are incorporated with upstream ancestry preserved; two subsequently inspected commits through `e9221e44da` remain unmerged. Remote deployment remains separate.

- **Branch integration**: [Upstream integration](upstream-integration.md) recorded local merge `801585a0bd` through upstream `5070a83a32`, with zero branch gap. At that observation, fork `main` remained at `373e85e766` with 48 incoming commits pending; Git and Jujutsu shared upstream's corrected named-base behavior. No push or deployment had occurred.

## 2026-10-12

- **Compatibility decision**: Recorded the [Crit remote review boundary](upstream-integration.md#crit-remote-review-boundary): review-owned, tailnet-only HTTPS endpoints stay separate from the environment's persistent publication. Implemented on this branch; live deployment remains separate.

- **Integration**: [PR #44](https://github.com/NicholasZolton/t3code/pull/44) reached fork `main` at `f4a2d2472c`. Refreshed [upstream integration](upstream-integration.md): all 374 newer commits through `e688034b5f` are incorporated with upstream ancestry preserved and zero remaining gap. Remote deployment remains separate.

- **Branch integration**: [Upstream integration](upstream-integration.md) records local merge `eec69e1928` through upstream `e688034b5f`, with all 374 missing commits incorporated on the branch. Fork `main` remains at `e373457c74` with that gap still pending. Adopted upstream package boundaries and Git-only cleanup; Jujutsu workspaces remain retained and ambiguous reused-child OpenCode reports remain guarded.

- **Compatibility decision**: [Paired Android notifications](paired-notifications.md) use a desktop-local macOS Keychain fallback for normal app launches. Explicit environment credentials retain precedence; SSH hosts still need their own configuration.

## 2026-10-10

- **Compatibility decision**: [Paired Android notifications](paired-notifications.md) now reuse Connect policy and presentation with encrypted rich payloads and phone-side environment aggregation. Recorded the earlier successful physical-phone generic delivery separately from pending encrypted-delivery rollout.

- **Compatibility decision**: Recorded the experimental [paired Android notification](paired-notifications.md) authorization and opaque-payload boundary. T3 Connect delivery remains a separate path; physical-phone delivery remains unverified.

## 2026-10-08

- **Integration**: [PR #37](https://github.com/NicholasZolton/t3code/pull/37) reached fork `main` at `e5365adddc`. Refreshed [upstream integration](upstream-integration.md): all 280 newer commits through `9a3070bcf0` are incorporated, with zero ancestry gap, upstream worktree-location and skill-refresh adoption, and preserved canonical checkout grouping.

- **Integration candidate**: Recorded branch merge `2bc0f73832` through upstream `9a3070bcf0` in [upstream integration](upstream-integration.md). The branch contains all 280 newer commits; fetched fork `main` at `e4b289c26c` still awaits them. Documented upstream worktree-location and skill-refresh adoption while retaining canonical checkout grouping and fork recovery boundaries.

## 2026-10-07

- **Signing identity**: Recorded the persistent [private Android signing key](upstream-integration.md#private-android-signing-identity) and the requirement to preserve it across builds and upstream syncs.

## 2026-10-06

- **Recovery exception**: Recorded the fork-side [SSH recovery boundary](upstream-integration.md#ssh-recovery-exception), which preserves remote work on connection timeouts. Upstream `3a9c1a6df1` still has the destructive recovery paths at the October 6 review.

## 2026-10-05

- **Integration**: [PR #34](https://github.com/NicholasZolton/t3code/pull/34) reached fork `main` at `2586800144`. Refreshed [upstream integration](upstream-integration.md): all 114 newer commits through `1604ccc9d7` are incorporated, with zero ancestry gap and the accepted upstream MCP replacement.

- **Integration candidate**: Recorded local full merge `ab7e864a1a` through upstream `1604ccc9d7` in [upstream integration](upstream-integration.md). All 114 newer commits are on the branch; fork `main` at `75c7b1b95c` still awaits them. The candidate replaces the fork MCP policy with upstream targeting and combines catalog freshness with discovery retries.

- **Maintenance**: Clarified the [SSH runtime handoff](upstream-integration.md#ssh-runtime-release-handoff) constraint: loopback readiness does not verify phone access. Remote deployments must preserve remembered Tailscale publication and verify the original HTTPS environment identity after deployment or rollback.

## 2026-10-03

- **Integration**: [PR #32](https://github.com/NicholasZolton/t3code/pull/32) reached fork `main` at `a9b81ef5c5`. Refreshed [upstream integration](upstream-integration.md): all 60 reviewed commits through `65731f986b` are incorporated, with zero ancestry gap. The completed V2 sync retains the accepted legacy-history and protocol 2 boundaries.

- **Integration candidate**: Updated [upstream integration](upstream-integration.md) for local merge `696fd65db1` through `65731f986b`, the accepted legacy-history boundary, and retained fork features. Fork `main` remains at `0a5b85436b`; deployment and main integration are pending.

- **Review**: Refreshed [upstream integration](upstream-integration.md) against fork `main` at `0a5b85436b` and upstream `65731f986b`: 60 commits remain unmerged, with 105 full-merge conflicts. Recorded V2 legacy-history and protocol rollout decisions, new upstream native OpenCode 2 support, and the fork compatibility protections still required.

## 2026-10-02

- **Integration**: [PR #27](https://github.com/NicholasZolton/t3code/pull/27) reached fork `main` at `60e0650513`. Refreshed [upstream integration](upstream-integration.md): all 50 reviewed commits through `99e08526e5` are incorporated, with zero remaining ancestry gap against that tip.
- **Integration candidate**: Recorded local full merge `24d2e49fd9` through upstream `99e08526e5` in [upstream integration](upstream-integration.md). The candidate includes all 50 commits; fork `main` at `b469d18b16` still awaits the sync. Retained the upstream-first policy and fork compatibility boundaries.

## 2026-09-30

- **Compatibility**: Added the selective Jujutsu port and durable mixed-backend recovery boundary to [upstream integration](upstream-integration.md), with links to the architecture and migration guidance.
- **Integration**: [PR #21](https://github.com/NicholasZolton/t3code/pull/21) reached fork `main` at `3da3d19cc2`. Refreshed [upstream integration](upstream-integration.md): all 81 commits through `0fcd5f9061` are incorporated, with zero remaining ancestry gap against that tip.
- **Update**: Recorded the full upstream branch merge `d8353ce56e` through `0fcd5f9061` in [upstream integration](upstream-integration.md), retained native OpenCode v2 compatibility, and documented SSH runtime version handoff. Fork `main` still awaits the 81-commit integration.
- **Initialization**: Established the repository-local OKF v0.2 bundle and [maintenance guidance](maintenance.md).
- **Creation**: Recorded [upstream integration](upstream-integration.md): the September 25 completed sync, the September 27 unmerged candidate, and the 81-commit gap split into 53 and 28 commits.
