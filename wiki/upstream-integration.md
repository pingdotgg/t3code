---
type: Integration Record
title: Upstream integration
description: Main and branch integration boundaries and fork compatibility exceptions.
tags: [upstream, fork, integration]
status: stable
generated:
  by: opencode/gpt-6.1-sol
  at: 2026-11-17T17:52:53+00:00
verified:
  - by: opencode/gpt-6.1-sol
    at: 2026-11-17T17:52:53+00:00
snapshot:
  at: 2026-11-17T17:52:53+00:00
  fork_main: 38ba9f1c7a493a0dbf8fed634f7ec04808c430ae
  upstream_main: b46edac5c1993b0c2cf721a5ffd3909709bcf7c0
  shared_baseline: c8c51af4e3f67ec9d121b3fb10b4cfd17adfd541
  last_main_integration: b20d057b87353167849d02e1031a334a91298dd7
  last_main_upstream: c8c51af4e3f67ec9d121b3fb10b4cfd17adfd541
  missing_upstream_on_main: 205
  missing_upstream_at_integrated_tip: 0
  branch_integration: 62999eedc1a7ba75e79c50a191281d3f3379c46f
  branch_parent: 38ba9f1c7a493a0dbf8fed634f7ec04808c430ae
  branch_code_tip: 62999eedc1a7ba75e79c50a191281d3f3379c46f
  missing_upstream_on_branch: 0
sources:
  - id: november-17-candidate
    resource: "Local candidate verification at 2026-11-17T17:52:53+00:00: initial merge 423f20588f1dbb437367d966a4f2617338263b87 has parents fetched fork main 38ba9f1c7a493a0dbf8fed634f7ec04808c430ae and upstream a99faf5a629023a5aca16fc8422553a5a4a9067f. Follow-up merge and code tip 62999eedc1a7ba75e79c50a191281d3f3379c46f has parents PR tip 7d9b97abc359ffc6c181ea76fbfc06c30c88f7f9 and upstream b46edac5c1993b0c2cf721a5ffd3909709bcf7c0, retaining the initial merge and all 205 incoming commits with zero branch gap; fork main still lacks them. Of 748 incoming paths without prior fork changes, 730 match upstream exactly; the other 18 register the fork's Prompts label in every web/mobile locale. Reference repositories match upstream. Shared recovery preserves upstream's empty worktree directory and Git/Jujutsu ownership; the real-repository case fails before the empty-directory guard is adapted and passes afterward. Upstream's fully-pushed-branch PR action already exists in the fork, so the merge retains one implementation. No live deployment occurred. This candidate has not reached main."
    title: November 17 candidate ancestry and compatibility verification
  - id: november-17-verification
    resource: "Verification at 2026-11-17T17:27:55+00:00: all 42 affected-package typechecks, production web/server/desktop builds, frozen dependency/patch checks, changed-file static checks, generated server/GitHub/Linear GraphQL checks and 261 selected React Compiler cases pass. The 360-file selection initially passes 9341 tests with three inherited skips. Focused recovery/workflow checks pass 110 tests; additional fork checks pass 92 and persistence checks pass 15. After fixing two retained settings fixtures and invoking Vite+ directly under Node 26 rather than pnpm's Node 24, the five-file failure selection passes all 247 tests. Final fixture check passes format, lint, both knip passes, three affected typechecks and 49 tests. All 16 remaining browser failures reproduce on pristine upstream a99faf5a62 with frozen dependencies; the keybinding case passes in isolation on both. Both SSH archive-launch cases fail on upstream too because their fake runtime has no node on its restricted PATH; temporarily naming process.execPath makes both pass, and that fixture workaround is not retained. Real web verification covers free Replay approval/completion, Issues, saved-prompt creation/insertion and Vim delete/undo. Managed device access is refused; iOS is unavailable. Offline theme-tool eval request generation passes; paid evals, native packaging and live deployment are not performed."
    title: Verified candidate and reproduced baseline limitations
  - id: november-17-upstream
    resource: https://github.com/pingdotgg/t3code/commit/b46edac5c1993b0c2cf721a5ffd3909709bcf7c0
    title: Pinned upstream tip for the November 17 sync
  - id: november-17-followup
    resource: "Follow-up verification at 2026-11-17T17:52:53+00:00: four newer upstream commits merge without conflicts. All ten changed paths match upstream apart from the existing fork content in Orchestrator.ts. The scoped check passes format, lint, both knip passes, generated GraphQL, 14 affected typechecks and seven React Compiler cases. Its nine-file selection passes 142 tests with one inherited skip; the sole SQL statement.stat failure passes when Vite+ is invoked directly under Node 26. The four direct feature suites pass 93 tests with one inherited skip. Production web/server rebuilds pass. GitHub has no check runs, workflow runs, reviews, requested reviewers or review threads after 16 minutes on the initial PR head; Actions is enabled and CI active."
    title: Four newer fixes and final scoped verification
  - id: november-17-pr
    resource: https://github.com/NicholasZolton/t3code/pull/84
    title: November 17 upstream integration PR and client evidence
  - id: november-16-main-git
    resource: "Local main verification at 2026-11-16T18:15:36+00:00: fetched origin/main equals eda7ca8f3ffac9a7d46b68815c9603193db80eae, with parents fork main 863c2620ff34abe9cd6f4ccb47aa7f21ea33b7f1 and PR tip 05785227d98f6ed0c5c2a71a4a5d71ad47fc66e3. Initial merge 933b5c5f2907d7c1ca9f4d4ca21086e4c0f22411, follow-up integration b20d057b87353167849d02e1031a334a91298dd7, final code tip 85f0a6c418ecdfe82fdbe713055a706c9a782ca3 and pinned upstream c8c51af4e3f67ec9d121b3fb10b4cfd17adfd541 are ancestors of main. All 967 incoming commits are incorporated, the shared baseline equals pinned upstream and zero upstream commits are missing on main. PR 81 merged at 2026-11-16T18:15:25Z without registered checks, workflow runs, reviews or pending reviewers. Local verification and reproduced baseline failures are recorded on the PR. No live deployment occurred."
    title: Completed November 16 main ancestry and merge verification
  - id: november-16-candidate
    resource: "Local candidate verification at 2026-11-16T18:12:49+00:00: initial merge 933b5c5f2907d7c1ca9f4d4ca21086e4c0f22411 has parents freshly fetched fork main 863c2620ff34abe9cd6f4ccb47aa7f21ea33b7f1 and upstream 6f5838f9bcdaf31864b93694c5935c93f9532e06. Follow-up merge b20d057b87353167849d02e1031a334a91298dd7 retains it and incorporates upstream c8c51af4e3f67ec9d121b3fb10b4cfd17adfd541. Code tip 85f0a6c418ecdfe82fdbe713055a706c9a782ca3 retains both merges and all 967 incoming commits, with zero branch gap; fork main still lacks them. Of 1763 incoming paths without prior fork changes, 1760 match upstream exactly. ThreadFeed passes Jujutsu terminology to the preparing header; two composer/shortcut fixtures supply retained fork dependencies and registration scopes. All reference repositories match upstream. PR 81 is open; the candidate has not reached main and no live deployment has occurred."
    title: Validated November 16 candidate, subsequently incorporated into main
  - id: november-16-verification
    resource: "Verification at 2026-11-16T18:12:49+00:00: production web/server/desktop builds pass 5/5; all 41 affected-package typechecks and final scoped server/OpenCode checks pass. Changed-file static checks, frozen dependency/patch checks, 515 selected React Compiler cases and seven Node script cases pass. Partitioning the timed-out 838-file selection and adding fork regressions yields 17582 passing tests after fixture repairs, with 16 inherited skips. All 17 remaining browser failures reproduce on pristine upstream c8c51af4e3 with frozen dependencies; both SSH launch-process timeouts reproduce on fork main 863c2620ff with frozen baseline dependencies. The final repair check passes format, lint, both knip passes, GraphQL generation, four package typechecks and all 162 selected tests. No tests were weakened or newly skipped. The real isolated web client completes free Replay approval, persists/inserts saved prompts, finds settings and supports Vim delete/undo. Android boot and its suggested diagnostic fail; iOS is unavailable. GitHub has no checks, workflow runs or pending reviewers; Actions is enabled and CI is active, but no runs were created. Paid model evals, signed native packaging and live deployment were not performed."
    title: Verified candidate, now incorporated into main, and baseline limitations
  - id: november-16-pr
    resource: https://github.com/NicholasZolton/t3code/pull/81
    title: Completed November 16 integration PR and client evidence
  - id: november-16-upstream
    resource: https://github.com/pingdotgg/t3code/commit/c8c51af4e3f67ec9d121b3fb10b4cfd17adfd541
    title: Pinned upstream tip for the completed November 16 sync
  - id: opencode-permissions-retirement
    resource: ../packages/provider-opencode/src/server/v2/adapter.ts
    title: Upstream thread-controlled OpenCode permissions
  - id: november-13-candidate
    resource: https://github.com/NicholasZolton/t3code/commit/4e3eaf41faf1a967fd293715b34841ae69589ac2
    title: Ancestry-preserving November 13 merge, now incorporated into main
  - id: november-13-git
    resource: "Local Git verification at 2026-11-13T18:16:03+00:00: fetched origin/main equals 8843960553bb019be7cd203aa7965e5774cde4ed, with parents fork main a5f4dfdff860a0d5720d678b59e2eac0be2a5630 and PR tip 0e3a7ffb8bd8f7e6727b78931dceb8c60d953136. Integration 4e3eaf41faf1a967fd293715b34841ae69589ac2, final code tip ccb63c2129a16b7d9894d32115266cbc26ceb101, and pinned upstream 286eeea19f8b9b06f84c61c6a2f46fba65c52313 are ancestors of main. All 379 incoming commits are incorporated, the shared baseline equals pinned upstream, and zero upstream commits are missing on main. Of 1036 incoming paths without prior fork changes, 1033 match upstream exactly; restoreMissingWorktree delegates to the mixed-backend recovery service, and two fixtures use the fork's composer and recovery APIs. All .repos content matches upstream. PR 75 merged at 2026-11-13T18:15:36Z without GitHub checks or pending reviewers; Copilot could not review the file count. Local verification and limitations are recorded on the PR. No live deployment occurred."
    title: Completed main ancestry and merge verification
  - id: november-13-verification
    resource: "Final candidate verification at 2026-11-13T18:13:52+00:00: changed-file static checks, 41 affected-package typechecks, production web/server/desktop builds, and 269-file React Compiler coverage pass. Partitioning the timed-out 556-file test selection and adding 76 fork regression files yields 12901 passing tests and eight inherited skips after focused repairs. Nine chat-browser timeouts reproduce on pristine pinned upstream; the sidebar shortcut failure and two SSH process timeouts reproduce on fork main. All desktop update and CLI-shim cases pass with temporary staging outside the host's quota-limited /tmp; that staging change was not retained. SQLite and recording cases pass under Node 26. Final repair checks pass 91 and 189 tests. Real-client Replay, Prompts, settings search, keep-awake, and Vim work. Native verification is blocked by device-hub startup. No GitHub checks or pending reviewers are registered; Copilot cannot review the file count. Paid evals and live deployment were not performed."
    title: Verified candidate, now incorporated into main, and baseline limitations
  - id: november-13-pr
    resource: https://github.com/NicholasZolton/t3code/pull/75
    title: November 13 upstream integration and verification evidence
  - id: november-12-main
    resource: https://github.com/NicholasZolton/t3code/pull/73
    title: Completed November 12 upstream integration into fork main
  - id: november-12-main-git
    resource: "Local Git verification at 2026-11-12T17:51:51+00:00: fetched origin/main equals fee9ab51a2de5bab16c3aa78eab7b72923fdfe67, with parents fork main 0827e63928dc9d6fda9257dcf2cc9bce0bf2b922 and PR tip d2557e05ece52f40a04c9a3b496df439cc67dec1. Integration f792c3302544dd6830f6f1e4e7472f8a0ec2dfb6, final code tip d2557e05ece52f40a04c9a3b496df439cc67dec1, and pinned upstream 371963ce0b4cfe8bac3911efd57ae3af90750b41 are ancestors of main. All 507 incoming commits are incorporated, the shared baseline equals the pinned upstream tip, and zero upstream commits are missing on main. PR 73 merged at 2026-11-12T17:50:28Z with no CI checks or reviews registered. Local verification and its remaining limitations are recorded on the PR. No live deployment occurred."
    title: Completed main ancestry and merge verification
  - id: november-12-upstream
    resource: https://github.com/pingdotgg/t3code/commit/371963ce0b4cfe8bac3911efd57ae3af90750b41
    title: Pinned upstream tip for the November 12 sync
  - id: november-12-candidate
    resource: "Final candidate verification at 2026-11-12T17:51:51+00:00: merge f792c3302544dd6830f6f1e4e7472f8a0ec2dfb6 has parents fork main 0827e63928dc9d6fda9257dcf2cc9bce0bf2b922 and upstream 371963ce0b4cfe8bac3911efd57ae3af90750b41. Code tip d2557e05ece52f40a04c9a3b496df439cc67dec1 incorporates all 507 incoming commits with zero gap. Of 1033 incoming paths without prior fork changes, 1032 match upstream exactly; the project MCP clone fixture supplies Jujutsu dependencies. Production web/server/desktop builds, all 41 affected package typechecks, 284-file React Compiler coverage, changed-file static checks, and focused fork regressions pass. The 514-file selection has 11726 passing tests and five inherited skips. Integration fixture failures were repaired and checked separately. Eight browser timeouts reproduce on pristine upstream; two full-suite click timeouts pass in isolation on both upstream and the fork. Eight desktop failures are blocked by this host's /tmp; all update and CLI-shim cases pass with temporary staging outside /tmp, which was not retained. Final scoped repair checks pass 30 and 35 tests; a separate remaining-case selection passes 54. Real-client Replay, Spanish settings/search, Prompts, Vim, and the Jujutsu menu work. Native verification is blocked by device-hub startup. These commits reached main through PR 73. No live deployment occurred."
    title: Validated November 12 candidate and verification limitations
  - id: november-11-main
    resource: https://github.com/NicholasZolton/t3code/pull/72
    title: Completed November 11 upstream integration into fork main
  - id: november-11-main-git
    resource: "Local Git verification at 2026-11-11T18:09:26+00:00: fetched origin/main equals 0187eabf9e2671e2346c5cf2d6f927d0826a3361, with parents fork main ec6fa2d3b84793a358fe224da413c895ef142085 and PR tip 10d641ca7665d0a8496a77da8e0c0f944034e972. Integration 2e1b75aa3266e50e0f9d8b29c824b34158a3f16f, final code tip 69793191b9a519890576f484aba4d4beaafdb118, and pinned upstream 1d152c3df4c54419c0e85070d8f89bc302f36658 are ancestors of main. All 161 incoming commits are incorporated, the shared baseline equals the pinned upstream tip, and zero upstream commits are missing on main. PR 72 merged at 2026-11-11T18:09:08Z. No CI checks registered; Copilot could not review the file count. Local verification and reproduced baseline failures are recorded on the PR. No live deployment occurred."
    title: Completed main ancestry and merge verification
  - id: november-11-candidate
    resource: "Local Git verification at 2026-11-11T18:08:00+00:00: merge 2e1b75aa3266e50e0f9d8b29c824b34158a3f16f has parents fork main ec6fa2d3b84793a358fe224da413c895ef142085 and upstream 1d152c3df4c54419c0e85070d8f89bc302f36658. Code tip 69793191b9a519890576f484aba4d4beaafdb118 preserves all 161 incoming commits, with zero branch gap. All 644 incoming paths without prior fork changes match upstream exactly. Fork main still has a 161-commit gap. Production web/server/desktop builds, 41 affected-package typechecks, 230-file React Compiler coverage, changed-file static checks, final scoped checks, and focused fork regressions pass. The 369-file selection has 9449 passing tests after repairing the fork fixture and MCP budget, using Node 26 for the SQLite performance case, and using a non-hidden temporary path for ASAR packaging. Four full-app browser failures reproduce on pristine upstream; the sidebar shortcut failure and five quota-blocked desktop settings cases reproduce on fork main. Three pre-existing skips were not changed. Real-client Replay, question submission, Vim editing, Prompts settings, and the clean-repository Jujutsu menu work. Native verification is blocked by device-hub startup. Copilot cannot review the file count; no CI checks registered and no live deployment occurred."
    title: Validated November 11 candidate and verification limitations
  - id: november-11-upstream
    resource: https://github.com/pingdotgg/t3code/commit/1d152c3df4c54419c0e85070d8f89bc302f36658
    title: Pinned upstream tip for the November 11 sync
  - id: opencode-codex-limits-restoration
    resource: ../packages/provider-opencode/src/server/codexUsageLimits.ts
    title: Read-only Codex subscription limits through OpenCode's selected connection
  - id: november-10-main
    resource: https://github.com/NicholasZolton/t3code/pull/71
    title: Completed November 10 upstream integration into fork main
  - id: november-10-main-git
    resource: "Local Git verification at 2026-11-10T17:44:03+00:00: fetched origin/main equals abb6f0b72a0226029c6977d6d92389d0376544c7, with parents fork main f8595a237d36af56a35d8c6d6dd8b154a6f5b063 and branch tip 5cc663abc27103138c4b53606a1dc27ec234958c. Integration 27d0bb4278e16f2fc70a2a31bccfa994a5d69628, compatibility repairs b69b4e7090831534d440d38e66fb3c0935a6274c, and upstream 8ee7183e6c8a1c22a6698f4909ef7e2a423bec3a are ancestors of main. All 114 incoming commits are incorporated, the shared baseline equals the pinned upstream tip, and zero upstream commits are missing on main. PR 71 merged at 2026-11-10T17:44:00Z. No CI checks or reviews were registered at merge. No live deployment occurred."
    title: Completed main ancestry and merge verification
  - id: november-10-candidate
    resource: "Final branch verification at 2026-11-10T17:44:03+00:00: merge 27d0bb4278e16f2fc70a2a31bccfa994a5d69628 has parents fork main f8595a237d36af56a35d8c6d6dd8b154a6f5b063 and upstream 8ee7183e6c8a1c22a6698f4909ef7e2a423bec3a. Code tip b69b4e7090831534d440d38e66fb3c0935a6274c retains all 114 incoming commits with zero branch gap. All 335 incoming paths without prior fork changes match upstream exactly. Five conflicted files retain upstream fixes and necessary fork behavior. Changed-file static checks, 41 affected package typechecks, 111-file React Compiler coverage, production web/server/desktop builds, 28 adaptation tests, 57 fork regressions, and 16 search tests pass. The final 169-file suite passes 4331 tests; three full-app browser cases and the SQLite statement.stat performance test fail on pristine upstream too. No tests were skipped or weakened. Real-client Replay, Vim, model mentions, Prompts settings, and small-fixture diff/find work. Native device verification is blocked by device-hub startup; paid evals and live deployment were not performed."
    title: Validated November 10 branch, now incorporated into main
  - id: november-10-upstream
    resource: https://github.com/pingdotgg/t3code/commit/8ee7183e6c8a1c22a6698f4909ef7e2a423bec3a
    title: Pinned upstream tip for the November 10 sync
  - id: ssh-sibling-recovery
    resource: ../packages/ssh/src/runnerProcess.test.ts
    title: Real-process recovery coverage for managed, external, discovered, and sibling servers
  - id: november-9-followup-main
    resource: https://github.com/NicholasZolton/t3code/pull/69
    title: Completed November 9 follow-up integration into fork main
  - id: november-9-followup-main-git
    resource: "Local Git verification at 2026-11-09T17:18:22+00:00: fetched origin/main equals 7a0869df09c91d721d7b77565bbe8cab2c0f0bf1, with parents fork main 7265fa73f437c896336820dd6146010e1897bc97 and branch tip fd06a4b7aadcb2c799b342ec0b9e50f4dbfa626d. Merge 82fe80c22ec4c40f51e29951a0bc42d066da1861 and pinned upstream 7b248349bdc066b1488f52083662597ab22d6fe3 are ancestors of main. The shared baseline equals that upstream tip, all 48 incoming commits are incorporated, and zero upstream commits are missing on main. PR 69 merged at 2026-11-09T17:18:10Z. No CI checks or reviews were registered at merge. Local verification and its three reproduced upstream browser failures and native verification gap are recorded on the PR. No live deployment occurred."
    title: Completed follow-up main ancestry and merge verification
  - id: november-9-followup-candidate
    resource: "Local Git verification at 2026-11-09T17:15:31+00:00: merge 82fe80c22ec4c40f51e29951a0bc42d066da1861 has parents fork main 7265fa73f437c896336820dd6146010e1897bc97 and upstream 7b248349bdc066b1488f52083662597ab22d6fe3. All 48 incoming commits are ancestors of the branch, with zero branch gap. Fork main still lacks those commits, sharing baseline 5ee1dbffbea1c3e2930f6512a99e81e8c4ecc3c4. Of 275 incoming paths without prior fork changes, 273 match upstream exactly; the shared model-search implementation retains fork ranking after upstream moved it, and the chat-status test covers Jujutsu identity. Changed-file format, lint, patch install, knip, GraphQL, 41-package typecheck, and React Compiler checks pass. Tests pass 3418 cases; three full-app browser failures reproduce on a pristine checkout of the pinned upstream, and the draft case also fails on fork main. Production web/server builds and 99 focused fork regression tests pass. A real browser verified onboarding, a complete free Replay turn with approval, and model mention insertion. Native verification is blocked by the device hub failing to start; paid model evals and desktop packaging were not run. No live deployment has occurred."
    title: November 9 follow-up candidate boundary, now incorporated into main
  - id: november-9-followup-upstream
    resource: https://github.com/pingdotgg/t3code/commit/7b248349bdc066b1488f52083662597ab22d6fe3
    title: Pinned upstream tip for the November 9 follow-up
  - id: november-9-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/68
    title: Completed November 9 upstream integration into fork main
  - id: november-9-main-review-git
    resource: "Local Git verification at 2026-11-09T06:58:19+00:00: fetched origin/main equals 2d55bfc6f46b5fb508f063ad57f73cdf0a6b8535, with parents 19474d8c52d9c558472d51a4456a25eb08fcf19e and 87eecdc25518d90b0786dfa0f0d842b3dce7aebe. Initial merge fcf161aee52d30da2fb9607d9ae5893e15bd6b59, final integration e5f32987d0e27564e7edf043e9502e3aa2e12f03, and pinned upstream 5ee1dbffbea1c3e2930f6512a99e81e8c4ecc3c4 are ancestors of main. The shared baseline equals the pinned upstream tip; all 95 incoming commits are incorporated and zero are missing on main. PR 68 merged at 2026-11-09T06:58:06Z. Copilot could not review the file count and no CI checks were registered; the PR records local verification and its gaps. No live deployment has occurred."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: november-9-latest-integration
    resource: "Local Git verification at 2026-11-09T06:38:55+00:00: merge e5f32987d0e27564e7edf043e9502e3aa2e12f03 has parents branch 50cc2a17aa6e68d1d464c013027389ccb767bfea and upstream 5ee1dbffbea1c3e2930f6512a99e81e8c4ecc3c4. It preserves initial merge fcf161aee52d30da2fb9607d9ae5893e15bd6b59 and all 95 incoming upstream commits, with zero branch gap. Fetched origin/main remains 19474d8c52d9c558472d51a4456a25eb08fcf19e and lacks those commits. Of 545 incoming paths without prior fork changes, 543 match upstream exactly; two mobile branch-sheet fixtures supply the fork's VCS terminology. Additional test changes follow upstream's hashed worktree names. Changed-file checks pass except the full-app draft browser test, whose timeout also reproduces in a clean checkout of fork main. Production web, server, and marketing builds pass; native clients remain unverified. The merge is not yet on main; no live deployment has occurred."
    title: Latest candidate ancestry and upstream-first source audit, now incorporated into main
  - id: november-9-local-integration
    resource: "Local Git verification at 2026-11-09T06:06:40+00:00: merge fcf161aee52d30da2fb9607d9ae5893e15bd6b59 has parents fork 19474d8c52d9c558472d51a4456a25eb08fcf19e and upstream c4ce7b0fd74f6beb37ed6034f5c8416e5aa7e165. All 92 incoming commits are ancestors of the branch, with zero branch gap. Fetched origin/main still lacks those commits and shares baseline e455200077ce60806a01c8f28435b58860dcfc74. All 502 incoming paths without prior fork changes match upstream byte-for-byte, including deleted paths. The merge is not yet on main; validation and client compatibility repairs are in progress. No live runtime deployment has occurred."
    title: Initial November 9 candidate merge and separate main boundary, now incorporated into main
  - id: november-9-upstream
    resource: https://github.com/pingdotgg/t3code/commit/5ee1dbffbea1c3e2930f6512a99e81e8c4ecc3c4
    title: Pinned upstream tip for the November 9 sync
  - id: november-7-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/59
    title: Completed November 7 upstream integration into fork main
  - id: november-7-main-review-git
    resource: "Local Git verification at 2026-11-07T17:09:56+00:00: fetched origin/main equals 703297e186f1f269c7ff11a20e34584b16b4e786, with parents c0bde3fa7067faa6ad3c8c5477e701199f0888e3 and f7aa77732c5d52f9b08bf8c9e8afc74ca73d0250. Integration 6087079d9d4297ea5f9681c397691a962b49c875, code tip 69a4603d988dc1ed30d9c1c85ad6e1892ceeab53, and pinned upstream e455200077ce60806a01c8f28435b58860dcfc74 are ancestors of main. The shared baseline equals the pinned upstream tip; all 277 incoming commits are incorporated and zero are missing on main. PR 59 merged at 2026-11-07T17:07:59Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: november-7-local-integration
    resource: "Local Git verification at 2026-11-07T16:55:59+00:00: merge 6087079d9d4297ea5f9681c397691a962b49c875 has parents fork c0bde3fa7067faa6ad3c8c5477e701199f0888e3 and upstream e455200077ce60806a01c8f28435b58860dcfc74. Descendant 69a4603d988dc1ed30d9c1c85ad6e1892ceeab53 preserves that merge and adapts fork code to upstream APIs. Zero upstream commits are missing on the branch. Fetched origin/main equals c0bde3fa7067faa6ad3c8c5477e701199f0888e3, sharing baseline 67eebaca23f8f7bc46e8817434087fc9c5acf8e3 with upstream and missing 277 incoming commits; the merge is not an ancestor of main. Of 1129 incoming paths without prior fork changes, 1127 match upstream exactly; the two exceptions keep fuzzy ranking in upstream's new shared reviewer filter. All .repos content matches upstream. The fork's divergence from upstream fell from 415 files (+34,899/-3,640) to 414 (+34,723/-3,508). These commits subsequently reached main through PR 59."
    title: Initial branch boundary and upstream-first source audit, now incorporated into main
  - id: november-7-upstream
    resource: https://github.com/pingdotgg/t3code/commit/e455200077ce60806a01c8f28435b58860dcfc74
    title: Pinned upstream tip incorporated into the completed November 7 sync
  - id: november-5-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/56
    title: Completed November 5 upstream integration into fork main
  - id: november-5-main-review-git
    resource: "Local Git verification at 2026-11-05T06:14:50+00:00: local main and fetched origin/main equal 53b9557983f2d9ab935abd96d63c8098f91917f3, with parents 9bcf77bb7083eb03de5f71cf220d5bfdf6940a45 and 48fbc5858a399afac714159811a728109c38f88a. Integration 1c01e0f4cab7d60cdc8ec35e41df586d6dc2a388, compatibility code tip cc28dd559547b93bd6c66727b60987d631aa26c9, and pinned upstream 67eebaca23f8f7bc46e8817434087fc9c5acf8e3 are ancestors of main. The shared baseline equals the pinned upstream tip; all 49 incoming commits are incorporated and zero are missing on main. PR 56 merged at 2026-11-05T06:13:56Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: november-5-local-integration
    resource: "Initial local Git verification at 2026-11-05T05:55:29+00:00: merge 1c01e0f4cab7d60cdc8ec35e41df586d6dc2a388 has parents fork 9bcf77bb7083eb03de5f71cf220d5bfdf6940a45 and upstream 67eebaca23f8f7bc46e8817434087fc9c5acf8e3. Descendant cc28dd559547b93bd6c66727b60987d631aa26c9 preserves that merge and adapts Jujutsu workspace availability and schema-aware SSH errors. Both parents are ancestors of the code tip; zero upstream commits are missing on the branch. At that observation, fork main remained at 9bcf77bb7083eb03de5f71cf220d5bfdf6940a45 with 49 incoming commits missing and shared baseline 3368dd70f20cb192b68895494a4a73455524fb76. Of 543 incoming paths without prior fork changes, 542 match upstream exactly; relayJwt.ts only marks its relay-consumed public key importer as public for the scoped export check. No push, PR, packaging, deployment, or live-server restart had occurred. These commits subsequently reached main through PR 56."
    title: Initial branch boundary and upstream-first source audit, now incorporated into main
  - id: november-5-upstream
    resource: https://github.com/pingdotgg/t3code/commit/67eebaca23f8f7bc46e8817434087fc9c5acf8e3
    title: Pinned upstream tip incorporated into the completed November 5 sync
  - id: november-4-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/55
    title: Completed November 4 upstream integration and OpenCode usage retirement
  - id: november-4-main-review-git
    resource: "Local Git verification at 2026-11-04T07:32:33+00:00: local main and fetched origin/main equal 0406c1c1be2fe50e8ea78df42febd3919481d750, with parents 470e518f7760790cae1e2fbb1e40fb1c30d4791a and e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa. Integration 865f3f977091580bc9e72236d7b042d617b2d1c1, final code tip e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa, and pinned upstream 3368dd70f20cb192b68895494a4a73455524fb76 are ancestors of main. The shared baseline equals the pinned upstream tip; all 351 incoming commits are incorporated and zero are missing on main. PR 55 merged at 2026-11-04T07:28:58Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: november-4-opencode-usage-removal
    resource: https://github.com/NicholasZolton/t3code/commit/e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa
    title: Deliberate retirement of the fork-only OpenCode usage integration
  - id: november-4-local-integration
    resource: "Git object 865f3f977091580bc9e72236d7b042d617b2d1c1; parents fork 470e518f7760790cae1e2fbb1e40fb1c30d4791a and upstream 3368dd70f20cb192b68895494a4a73455524fb76. Follow-up 42faa17d53171bc537bdcd6855ec561995ce7005 adapts fork mobile prompts to upstream's settings menu, and 9b7bee668b6fd6d210c57fef622daac4c28293dd adapts fork test fixtures to the new settings and crypto APIs. Final code tip e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa removes the fork-only OpenCode account/quota integration. These commits reached main through PR 55."
    title: Ancestry-preserving integration and compatibility adaptations
  - id: november-4-review-git
    resource: "Local Git verification at 2026-11-04T06:18:54+00:00: local main and origin/main equal 470e518f7760790cae1e2fbb1e40fb1c30d4791a. Shared baseline with upstream/main 3368dd70f20cb192b68895494a4a73455524fb76 is dd6c05ec313c6c870c7a7688e87143da5084031d, leaving 351 upstream commits missing on main. Both merge parents and merge 865f3f977091580bc9e72236d7b042d617b2d1c1 are ancestors of code tip 9b7bee668b6fd6d210c57fef622daac4c28293dd; its upstream gap is zero. The merge is not an ancestor of main. Of 1156 incoming paths without prior fork changes, 1155 match upstream exactly; only AgentSessionScanner.test.ts adds fork integration coverage. All .repos content matches upstream. No push, PR, packaging, deployment, or live-server restart has occurred."
    title: Separate local-branch and unchanged-main boundaries with upstream-first source audit
  - id: november-4-upstream
    resource: https://github.com/pingdotgg/t3code/commit/3368dd70f20cb192b68895494a4a73455524fb76
    title: Pinned upstream tip incorporated into the completed November 4 sync
  - id: november-2-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/52
    title: Completed November 2 upstream integration into fork main
  - id: november-2-main-review-git
    resource: "Local Git verification at 2026-11-02T04:28:13+00:00: fetched origin/main and local main both equal 9a73f5dd047b5a63069cb8350863f6a35f2735a2, with parents c98f21e930f67ead4aac04137b2a0e1398849b0a and 892da10b7eee5193eba7393fa091113833b94c7a. Reused merge e7d7a393d980059c14fc65f2892f6b04112bf06f, integration ed52b86b6a9ffb6afad94980cc3d7d8cb5c851aa, and upstream dd6c05ec313c6c870c7a7688e87143da5084031d are ancestors of main. The shared baseline equals the pinned upstream tip, all 3337 incoming commits are incorporated, and zero upstream commits are missing on main. PR 52 merged at 2026-11-02T04:27:11Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: november-2-local-integration
    resource: "Git object ed52b86b6a9ffb6afad94980cc3d7d8cb5c851aa on NicholasZolton/merge-upstream-changes-6; parents e7d7a393d980059c14fc65f2892f6b04112bf06f and dd6c05ec313c6c870c7a7688e87143da5084031d. Reused merge e7d7a393d980059c14fc65f2892f6b04112bf06f has parents c98f21e930f67ead4aac04137b2a0e1398849b0a and 18e27425195686a5215fdc2cfa2bca088cdb8972. Descendant repairs are 8df64329df2f7e3ce954e875ad8866ef800de545 and 1a21e4d0e63552b32678c3bf0e07be47f2a45198; the merge itself is unchanged. These commits subsequently reached main through PR 52."
    title: Ancestry-preserving integration through the pinned November upstream tip
  - id: november-2-review-git
    resource: "Local Git verification at 2026-11-02T04:18:39+00:00: local main and origin/main both equal c98f21e930f67ead4aac04137b2a0e1398849b0a. The shared baseline with upstream/main dd6c05ec313c6c870c7a7688e87143da5084031d is 3962ae8586333310eeef655c917389b35f7b679d, leaving 3337 upstream commits missing on main. Fork main, reused merge e7d7a393d980059c14fc65f2892f6b04112bf06f, and pinned upstream are ancestors of local integration ed52b86b6a9ffb6afad94980cc3d7d8cb5c851aa. That integration is an ancestor of code tip 1a21e4d0e63552b32678c3bf0e07be47f2a45198; the branch's merge base equals the pinned upstream tip and its missing-upstream count is zero. Integration ed52b86b6a9ffb6afad94980cc3d7d8cb5c851aa is not an ancestor of main. No push, PR, packaging, deployment, or server restart has occurred."
    title: Distinct local-branch and unchanged-main integration boundaries
  - id: november-2-upstream
    resource: https://github.com/pingdotgg/t3code/commit/dd6c05ec313c6c870c7a7688e87143da5084031d
    title: Pinned upstream tip incorporated into the local integration branch
  - id: workspace-recovery
    resource: ../apps/server/src/git/GitWorkflowService.ts
    title: Shared workspace recovery with backend ownership and branch-base fallback
  - id: opencode-child-tracking
    resource: ../packages/provider-opencode/src/server/v2/adapter.ts
    title: Upstream OpenCode lifecycle with fork reused-child and input-delivery safeguards
  - id: composer-collapse-removal
    resource: https://github.com/pingdotgg/t3code/commit/bd84b1781a7febb7398a6838cad0416a3240da1a
    title: Upstream removes the collapsed composer and its scroll-collapse setting
  - id: october-16-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/50
    title: Completed October 16 upstream integration into fork main
  - id: october-16-main-review-git
    resource: "Local Git verification at 2026-10-16T14:32:27+00:00: fetched origin/main and local main both equal d3b3491750d65d0ddfc8bd1b192c616005560d64, with parents f2d43354c9acdd8b2ecd777afa8fb9103ff336fb and 80c7adc76b539ce0240aa541d8a1a0c83d23d5a2. Integration 837d227b910791a9f9c28c6fea2609af3f40085c and upstream 3962ae8586333310eeef655c917389b35f7b679d are ancestors of main. The shared baseline equals that pinned upstream tip, all 96 incoming commits are incorporated, and zero upstream commits are missing on main. PR 50 merged at 2026-10-16T14:31:00Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: october-16-branch-integration
    resource: https://github.com/NicholasZolton/t3code/commit/837d227b910791a9f9c28c6fea2609af3f40085c
    title: Ancestry-preserving merge through 3962ae8586, now incorporated into main
  - id: october-16-review-git
    resource: "Local Git verification at 2026-10-16T04:12:58+00:00: origin/main and local main equal f2d43354c9acdd8b2ecd777afa8fb9103ff336fb. The shared baseline with upstream 3962ae8586333310eeef655c917389b35f7b679d is e536bfd33bc3c351997141d93790df75eeded7b9, leaving 96 upstream commits missing on main. Merge 837d227b910791a9f9c28c6fea2609af3f40085c has that fork main and pinned upstream tip as parents, with zero missing upstream commits on the branch. All 669 incoming paths without prior fork changes match upstream byte-for-byte. Fork prompts, Vim, shortcuts, weighted search, OpenCode safeguards and accounts, SSH guards, paired notifications, Crit/Portless, and Jujutsu remain. No push, main integration, or remote deployment has occurred."
    title: Branch ancestry, main gap, and upstream-first source audit
  - id: october-16-upstream
    resource: https://github.com/pingdotgg/t3code/commit/3962ae8586333310eeef655c917389b35f7b679d
    title: Pinned upstream tip for the completed October 16 integration
  - id: october-15-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/48
    title: Completed October 15 upstream integration into fork main
  - id: october-15-main-review-git
    resource: "Local Git verification at 2026-10-15T14:33:08+00:00: fetched origin/main and local main both equal 9ce8f0a504b8abe1af9feead20ae1714c0d9ded8, with parents e9e7b07c0dfdc421d4216b2164cd4efe4ec4588d and d3b9e1b76e9815a6dfae066d85a272f24c81536d. Integration 30b7fbff813e913ac3b88ae58ebe1dd47b50fc4f and upstream e536bfd33bc3c351997141d93790df75eeded7b9 are ancestors of main. The shared baseline equals that pinned upstream tip, all 106 incoming commits are incorporated, and zero upstream commits are missing on main. PR 48 merged at 2026-10-15T14:32:29Z. Remote deployment remains separate."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: october-15-branch-integration
    resource: https://github.com/NicholasZolton/t3code/commit/30b7fbff813e913ac3b88ae58ebe1dd47b50fc4f
    title: Ancestry-preserving merge through e536bfd33b, now incorporated into main
  - id: october-15-review-git
    resource: "Local Git verification at 2026-10-15T04:11:12+00:00: origin/main and local main equal e9e7b07c0dfdc421d4216b2164cd4efe4ec4588d. The shared baseline with upstream e536bfd33bc3c351997141d93790df75eeded7b9 is 6002c5c68c637de2cd2557bd6c40e46c153e39b1, leaving 106 upstream commits missing on main. Merge 30b7fbff813e913ac3b88ae58ebe1dd47b50fc4f has fork e9e7b07c0dfdc421d4216b2164cd4efe4ec4588d and upstream e536bfd33bc3c351997141d93790df75eeded7b9 as parents, with zero missing upstream commits on the branch. Of 425 incoming paths without prior fork changes, 423 match upstream byte-for-byte; two composer tests supply the fork's required keybindings. Upstream managed SSH recovery and ownership cleanup are adopted; external/discovered readiness guards and unreplaced fork features remain. No push, main integration, or remote deployment has occurred."
    title: Branch ancestry, main gap, and upstream-first source audit
  - id: october-15-upstream
    resource: https://github.com/pingdotgg/t3code/commit/e536bfd33bc3c351997141d93790df75eeded7b9
    title: Pinned upstream tip for the October 15 branch integration
  - id: october-14-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/47
    title: Completed October 14 upstream integration into fork main
  - id: october-14-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/65729a46467ede150ca3b42ad34f58e9f23d027f
    title: Fork main after PR 47 merged with upstream ancestry preserved
  - id: october-14-main-review-git
    resource: "Local Git verification at 2026-10-14T15:40:24+00:00: fetched origin/main and local main both equal 65729a46467ede150ca3b42ad34f58e9f23d027f, with parents 1a005f7db369b60533d98ef63177cf03e765b50d and ba5362c81a1082db1eac60f0d666ea8380474d7c. Both upstream merges 24ab07ed900d70c4fac0e06c58262d818e202753 and 2f17f4f635e021d775c0f6c1ebe030bcba0f5d55 are ancestors of main. The shared baseline equals upstream 6002c5c68c637de2cd2557bd6c40e46c153e39b1, with all 42 incoming commits incorporated and zero missing upstream commits. PR 47 merged at 2026-10-14T15:39:28Z."
    title: Completed main ancestry checks against the pinned upstream tip
  - id: october-14-branch-integration
    resource: https://github.com/NicholasZolton/t3code/commit/2f17f4f635e021d775c0f6c1ebe030bcba0f5d55
    title: Ancestry-preserving integration through 6002c5c68c, now incorporated into main
  - id: october-14-review-git
    resource: "Local Git verification at 2026-10-14T04:13:20Z: fetched origin/main 1a005f7db369b60533d98ef63177cf03e765b50d and upstream/main 6002c5c68c637de2cd2557bd6c40e46c153e39b1 share baseline 5070a83a3248c537d3baaf063e719f179c49bb52, with 42 missing upstream commits on main. Initial merge 24ab07ed900d70c4fac0e06c58262d818e202753 has fork main and upstream 11fd54fcbbfb39f824bb4c908d428c20d801267c as parents. Follow-up merge 2f17f4f635e021d775c0f6c1ebe030bcba0f5d55 has branch parent 0a5dafd0eb94641d642324c727ed1c9683556c43 and upstream 6002c5c68c637de2cd2557bd6c40e46c153e39b1 as parents, contains the initial merge, and has zero missing upstream commits. Of 115 incoming paths without prior fork changes, 114 are byte-identical to upstream; the only exception uses GITHUB_EVENT_PATH in the webhook workflow. Both web scoped-settings implementation paths now match upstream exactly. SSH recovery, OpenCode child execution tracking, and the bundled model manifest are unchanged in the incoming range."
    title: Initial branch boundary and upstream-first resolutions before main integration
  - id: october-14-upstream
    resource: https://github.com/pingdotgg/t3code/commit/6002c5c68c637de2cd2557bd6c40e46c153e39b1
    title: Pinned upstream tip for the completed October 14 integration
  - id: october-13-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/46
    title: Completed October 13 upstream integration into fork main
  - id: october-13-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/eb4dc2fd6e962f129b6969883927438b57cfe36c
    title: Fork main after PR 46 merged with upstream ancestry preserved
  - id: october-13-integration
    resource: https://github.com/NicholasZolton/t3code/commit/801585a0bd383420165e9139e323ee67f6507a9a
    title: Ancestry-preserving integration through 5070a83a32, now incorporated into main
  - id: october-13-review-git
    resource: "Local Git verification at 2026-10-13T05:39:00Z: fetched origin/main eb4dc2fd6e962f129b6969883927438b57cfe36c contains integration 801585a0bd383420165e9139e323ee67f6507a9a and upstream 5070a83a3248c537d3baaf063e719f179c49bb52; all 48 incoming commits are incorporated with zero gap at the integrated tip; shared baseline against fetched upstream e9221e44dadd78126c83d2eeed0b51c25dcf0fb4 is 5070a83a3248c537d3baaf063e719f179c49bb52, leaving exactly 540a3e89ed and e9221e44da unmerged; PR 46 merged at 2026-10-13T05:38:02Z"
    title: Completed main integration and two newer unmerged commits verified separately
  - id: october-13-upstream
    resource: https://github.com/pingdotgg/t3code/commit/5070a83a3248c537d3baaf063e719f179c49bb52
    title: Pinned upstream tip for the latest main integration
  - id: october-13-newer-upstream
    resource: https://github.com/pingdotgg/t3code/compare/5070a83a3248c537d3baaf063e719f179c49bb52...e9221e44dadd78126c83d2eeed0b51c25dcf0fb4
    title: Two subsequently inspected upstream commits, not included in PR 46
  - id: shared-pr-workflow
    resource: ../apps/server/src/jj/JjWorkflow.ts
    title: Jujutsu adapter feeds named bases into the shared change-request workflow
  - id: crit-tailnet-forwarding
    resource: ../apps/server/src/process/CritManager.ts
    title: Review-owned Crit forwarding, implemented on this branch; deployment is separate
  - id: tailscale-foreground-serve
    resource: https://github.com/tailscale/tailscale/blob/3caf7d9e7dcaba589cfc58beda596929733e4fea/cmd/tailscale/cli/serve_v2.go
    title: Tailscale foreground Serve sessions and their connection-owned lifetime
  - id: october-12-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/44
    title: Completed October 12 full upstream integration into fork main
  - id: october-12-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/f4a2d2472c90d7828be6830cfee01f4b76d7f2f7
    title: Fork main after PR 44 merged with upstream ancestry preserved
  - id: october-12-branch-integration
    resource: https://github.com/NicholasZolton/t3code/commit/eec69e1928b4aadf52e78fd2b14f9df6aa1f5f44
    title: Ancestry-preserving upstream merge now incorporated into fork main
  - id: october-12-review-git
    resource: "Local Git verification at 2026-10-12T06:04:06Z: fetched origin/main f4a2d2472c90d7828be6830cfee01f4b76d7f2f7 contains integration eec69e1928b4aadf52e78fd2b14f9df6aa1f5f44 and upstream e688034b5f5505f92fcf1d78ba853c9c0107f9f1; the merge base is the pinned upstream tip, with all 374 previously missing commits incorporated and zero remaining main ancestry gap; PR 44 merged at 2026-10-12T06:03:14Z"
    title: Completed main integration boundary verified against pinned upstream
  - id: october-8-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/37
    title: Completed October 8 full upstream integration into fork main
  - id: october-8-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/e5365adddc46e74a197f1f698a6ec79f12b92d99
    title: Fork main after PR 37 merged with upstream ancestry preserved
  - id: october-8-integration
    resource: https://github.com/NicholasZolton/t3code/commit/2bc0f738329c83c0a7e146018d640a512634f876
    title: Full upstream merge with parents e4b289c26c and 9a3070bcf0, now incorporated into main
  - id: october-8-review-git
    resource: "Local Git verification at 2026-10-08T18:51:57Z: origin/main e5365adddc46e74a197f1f698a6ec79f12b92d99 contains integration 2bc0f738329c83c0a7e146018d640a512634f876 and upstream 9a3070bcf023c3c025633659addeef4cf628133a; merge base is the pinned upstream tip; all 280 previously missing commits are incorporated with zero ancestry gap; PR 37 merged at 2026-10-08T18:49:13Z"
    title: Verified completed October 8 integration boundary
  - id: upstream-worktree-location
    resource: https://github.com/pingdotgg/t3code/commit/1024941575067f68d909c6b98f56b02edac25b37
    title: Upstream worktree location and previous-directory tracking
  - id: upstream-skill-refresh
    resource: https://github.com/pingdotgg/t3code/commit/a1830915ecf70e3ad4fbe8efb15ae9f18517eb54
    title: Upstream five-minute workspace discovery cache and refresh policy
  - id: october-5-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/34
    title: Completed October 5 full upstream integration into fork main
  - id: october-5-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/258680014485a577ecb2f07829caf432b874d3ea
    title: Fork main after PR 34 merged with upstream ancestry preserved
  - id: october-5-candidate
    resource: https://github.com/NicholasZolton/t3code/commit/ab7e864a1aa3ce44d99454b8e363297227475ead
    title: Full upstream merge through October 5, now incorporated into main
  - id: october-5-candidate-decisions
    resource: "Integrated tree at ab7e864a1aa3ce44d99454b8e363297227475ead: MCP directory and restored OpenCode helper tests match upstream 1604ccc9d79f5270fb8e14d60664184bf142c4cb; custom agent thread access policy and settings removed; workspace freshness and invalidation combined with incomplete-discovery retries"
    title: Verified upstream-first conflict resolutions
  - id: upstream-mcp-targeting
    resource: https://github.com/pingdotgg/t3code/commit/06e627448b
    title: Upstream explicit MCP targets, external callers, and permission ceilings
  - id: current-integration
    resource: https://github.com/NicholasZolton/t3code/commit/696fd65db117198476ad840ca41c4af031b086c4
    title: Completed V2 integration with preserved upstream ancestry
  - id: current-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/32
    title: Completed October 3 full upstream integration into fork main
  - id: current-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/a9b81ef5c5017cc8268a7ca408ddb8430cc370c5
    title: Fork main after PR 32 merged
  - id: current-git-history
    resource: "Local Git verification: fork main a9b81ef5c5017cc8268a7ca408ddb8430cc370c5 contains integration 696fd65db117198476ad840ca41c4af031b086c4 and upstream 65731f986ba2175063b0182deb6a143f8f323b74; merge base is the pinned upstream tip and the remaining ancestry gap is zero"
    title: Verified completed V2 integration boundary
  - id: reviewed-fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/75c7b1b95c9df64a239c6ffa06ef1e7a694008a0
    title: Fork main at the October 5 integration verification
  - id: reviewed-upstream-main
    resource: https://github.com/pingdotgg/t3code/commit/1604ccc9d79f5270fb8e14d60664184bf142c4cb
    title: Upstream main at the October 5 review
  - id: latest-review-git
    resource: "Local Git verification at 2026-10-05T20:00:49Z: fork main 258680014485a577ecb2f07829caf432b874d3ea contains integration ab7e864a1aa3ce44d99454b8e363297227475ead and upstream 1604ccc9d79f5270fb8e14d60664184bf142c4cb; merge base is the pinned upstream tip; zero missing upstream commits on main; PR 34 merged at 2026-10-05T20:00:02Z"
    title: Verified completed October 5 integration boundary
  - id: upstream-v2
    resource: https://github.com/pingdotgg/t3code/commit/de343914273eceb852a1d1d739cd1d38df7796ee
    title: Upstream orchestrator V2 cutover
  - id: upstream-v1-cutover
    resource: https://github.com/pingdotgg/t3code/blob/65731f986ba2175063b0182deb6a143f8f323b74/apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts
    title: Messages-only legacy import and fresh-session continuation
  - id: upstream-protocol
    resource: https://github.com/pingdotgg/t3code/blob/65731f986ba2175063b0182deb6a143f8f323b74/packages/contracts/src/environment.ts
    title: Orchestration wire protocol version 2
  - id: upstream-current-manifest
    resource: https://github.com/pingdotgg/t3code/blob/6002c5c68c637de2cd2557bd6c40e46c153e39b1/apps/server/src/provider/model-manifest.json
    title: OpenCode version policy at the reviewed upstream tip
  - id: main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/27
    title: Completed full upstream integration into fork main
  - id: integration-commit
    resource: https://github.com/NicholasZolton/t3code/commit/24d2e49fd91aa8779992b187a3d3395a51de9138
    title: Upstream merge with preserved fork behavior
  - id: fork-main
    resource: https://github.com/NicholasZolton/t3code/commit/60e0650513868e092b20dde6bfcf3e27fa719180
    title: Fork main after PR 27 merged
  - id: upstream-main
    resource: https://github.com/pingdotgg/t3code/commit/99e08526e5ec84f294940cba5929841518c52fec
    title: Reviewed upstream main
  - id: previous-integration
    resource: https://github.com/NicholasZolton/t3code/commit/bd57816184c5b0e2db6110310c3655857eb817f1
    title: Previous completed integration through 6530de0339
  - id: previous-main-integration
    resource: https://github.com/NicholasZolton/t3code/pull/21
    title: Previous full upstream integration through 0fcd5f9061
  - id: native-v2-integration
    resource: https://github.com/NicholasZolton/t3code/commit/2ee019f626ca133fa2678ab2a16fa770afe9d351
    title: Earlier native OpenCode v2 integration
  - id: unmerged-candidate
    resource: "Local Git object a8df093eb69c1c6bc5f923e46b77f0a2d5f498b1 on NicholasZolton/audit-fork-upstream-differences"
    title: Earlier unmerged integration candidate
  - id: git-history
    resource: "Local Git inspection: fork main 60e0650513868e092b20dde6bfcf3e27fa719180 incorporates merge 24d2e49fd91aa8779992b187a3d3395a51de9138 and all 50 commits through upstream 99e08526e5ec84f294940cba5929841518c52fec; remaining ancestry gap is zero"
    title: Verified completed main integration boundary
  - id: ssh-deployment
    resource: ../scripts/deploy-ssh-runtime.sh
    title: Fork SSH runtime deployment and release handoff
  - id: remote-deployment-checks
    resource: ../AGENTS.md#remote-deployment-checks
    title: Persistent tailnet publication and remote deployment verification
  - id: tailscale-persistence
    resource: ../apps/server/src/cli/pair.ts
    title: Pairing with the running server and remembering Tailscale Serve settings
  - id: ssh-recovery
    resource: ../packages/ssh/src/tunnel.ts
    title: Upstream managed recovery with fork external/discovered readiness guards
  - id: upstream-ssh-recovery
    resource: https://github.com/pingdotgg/t3code/blob/e536bfd33bc3c351997141d93790df75eeded7b9/packages/ssh/src/tunnel.ts
    title: Upstream managed-server recovery and ownership cleanup at the reviewed tip
  - id: ssh-recovery-issue
    resource: https://github.com/pingdotgg/t3code/issues/15608
    title: Upstream report of remote work stopping on disconnect and stale-tunnel recovery
  - id: upstream-jujutsu
    resource: https://github.com/pingdotgg/t3code/pull/13816
    title: Upstream Jujutsu support selectively ported into the fork
  - id: fork-jujutsu
    resource: https://github.com/NicholasZolton/t3code/commit/10f6b88380011b466e0be0355b76874e41db43a2
    title: Fork Jujutsu port with durable mixed-backend workspace recovery
  - id: private-android-signing
    resource: ../docs/operations/android-notifications.md#private-fork-apk-signing
    title: Private fork APK signing with the repository's fnox local profile
  - id: fnox-provider-secrets
    resource: ../apps/server/src/fnoxSecrets.ts
    title: Server startup step that loads user-level fnox secrets for provider processes
  - id: tailnet-peer-links
    resource: ../apps/server/src/peer/PeerLinks.ts
    title: Plain-http check that accepts addresses the linking machine's Tailscale lists
  - id: sidebar-all-projects-search
    resource: ../apps/web/src/components/Sidebar.logic.ts
    title: Sidebar project filter search that ranks the All projects row with projects
  - id: open-in-default-app
    resource: ../apps/web/src/components/chat/OpenInPicker.tsx
    title: Open-in picker item that opens a file with the host's default app
  - id: pr-watch-review-hold
    resource: ../packages/shared/src/orchestrationV2PendingBackgroundWork.ts
    title: Opt-in PR approval hold alongside upstream's checks-only waiting
---

# Upstream integration

Fork `main` at `38ba9f1c7a` incorporates upstream through `c8c51af4e3`.
The November 17 candidate incorporates 205 newer commits through `b46edac5c1`,
with zero branch gap; those commits have not reached fork `main` yet.
Remote deployment remains separate.[^november-17-candidate]

This is a revision-pinned snapshot, not a claim about newer upstream work.
Refresh it after the next review or integration using the
[maintenance guidance](maintenance.md).

## November 17 candidate

Initial merge `423f20588f` retains fresh fork `main` and upstream `a99faf5a62`;
follow-up merge `62999eedc1` adds the four commits fetched while waiting for CI.
Of 748 incoming paths without prior fork changes, 730 match upstream exactly;
the other 18 add the fork's Prompts label to every web/mobile locale.
[^november-17-candidate][^november-17-upstream]

Keep upstream's Windows recovery fix: clear dependency leftovers inside the
worktree without removing the directory that a terminal may still use. The
shared recovery service must recognize that empty directory as needing a
checkout, while preserving its recorded Git/Jujutsu owner. Upstream's
fully-pushed-branch PR action already exists in the fork; keep one implementation.
[^november-17-candidate]

The 16 remaining browser failures reproduce on pristine upstream. Both SSH
archive-launch failures also reproduce there; their fake runtime cannot find
Node on its restricted PATH. Naming the current Node executable makes both pass,
but that fixture workaround is not retained. No integration-only failure remains
in those comparisons. Native verification is blocked by device access.
[^november-17-verification]

The follow-up adopts upstream's ACP disconnect deadline, concurrent-install
cleanup, queued Claude provider switch and disconnected mobile Settings scope.
Scoped checks and the web/server rebuild pass; GitHub has registered no checks
or reviews on [PR #84](https://github.com/NicholasZolton/t3code/pull/84).
[^november-17-followup][^november-17-pr]

## Completed November 16 sync

Merge `933b5c5f29` combines fresh fork `main` `863c2620ff` and upstream
`6f5838f9bc`; follow-up merge `b20d057b87` adds the two upstream fixes fetched
during verification. Of 1,763 incoming paths without prior fork changes, 1,760
match upstream exactly. `ThreadFeed` carries Jujutsu terminology into the new
mobile preparing header; two upstream fixtures supply the retained prompt command
and find preview commands across the fork's separate registration scopes.
[^november-16-candidate][^november-16-upstream]

Adopt upstream's folder-picker fuzzy and Unicode matching instead of maintaining
the overlapping fork implementation. Git and Jujutsu still share the PR workflow,
including upstream's push-remote and cross-repository fixes. A Git ref snapshot
cannot certify a Jujutsu status read; return no snapshot so the broadcaster keeps
its full reconciliation. OpenCode's upstream run attribution remains alongside
the fork's input-delivery safeguards: an undelivered continuation must not finish
from an older child report.[^november-16-candidate][^opencode-child-tracking][^shared-pr-workflow]

The partitioned selection passes 17,582 tests after fixture repairs. All 17
remaining browser failures reproduce on pristine pinned upstream, and the two
SSH process timeouts reproduce on fork `main`. The final repair check passes all
162 cases. Native verification remains blocked; no live deployment occurred.
[^november-16-verification][^november-16-pr]

PR #81 incorporates the merge and compatibility repairs into fork `main`.
The shared baseline now equals the pinned upstream tip, with all 967 incoming
commits retained and zero remaining ancestry gap.[^november-16-main-git]

## Completed November 13 sync

Merge `4e3eaf41fa` combines fork `main` `a5f4dfdff8` and upstream `286eeea19f`.
Of 1,036 incoming paths without prior fork changes, 1,033 match upstream exactly.
The shared worktree/terminal recovery helper delegates to the fork's existing
mixed Git/Jujutsu recovery service, rather than adding a Git-only recovery path.
Git recovery now honors the primary remote instead of assuming `origin`.
Two upstream fixtures use the fork's composer and recovery APIs.
[^november-13-candidate][^november-13-git]

Keep upstream's process-aware OpenCode recovery: owned live servers are not
abandoned on a read deadline, and Stop remains available during reconciliation.
The fork's reused-child admission and report-attribution safeguards remain inside
those locking boundaries. Console/Go limits from upstream do not replace the
fork's separate read-only Codex subscription limits.[^november-13-candidate]

Upstream's per-window plan capacities replace the fork's blanket quota weighting.
Explicit multiplier plan labels remain supported; segmented bars consume the same
weights as the pooled usage and resets. Mobile sheets use upstream's shared
`FitSheet` while retaining Jujutsu terminology and workspace removal.
[^november-13-candidate]

The configurable temporary branch prefix preserves upstream's default-name
fallback when settings secrets cannot be read. SSH's live-server guard permits
waiting through a valid desktop-update marker without replacing that server.
Validation and the remaining reproduced baseline failures are recorded on
[PR #75](https://github.com/NicholasZolton/t3code/pull/75).
[^november-13-verification][^november-13-pr]

## Completed November 12 sync

Merge `f792c33025` combines fork `main` `0827e63928` and upstream `371963ce0b`.
Of 1,033 incoming paths without prior fork changes, 1,032 match upstream exactly;
the project MCP clone fixture supplies the fork's Jujutsu dependencies. Reference
repositories are unchanged.[^november-12-candidate][^november-12-upstream]

PR #73 incorporates the merge and compatibility repairs into fork `main`.
The broad selection passes 11,726 tests; remaining browser timing and host `/tmp`
limitations, passing scoped repairs, and the native verification gap are recorded
on the PR. No tests were weakened or newly skipped, and no live deployment
occurred.[^november-12-main-git][^november-12-candidate]

Upstream's `closeAllTunnels` replaces the fork's separate SSH shutdown API.
It must also close owned Portless forwards during updates and ordinary quit.
Keep upstream's repository-probe errors distinct from missing checkpoints while
supporting Jujutsu checkpoint capability checks. Upstream's Tailscale route-owner
guard must check the actual published target, including the fork's development
web proxy. Localized settings search keeps the fork's fuzzy ranking.
[^november-12-candidate]

## Completed November 11 sync

Merge `2e1b75aa32` combines fork `main` `ec6fa2d3b8` and upstream `1d152c3df4`.
All 644 incoming paths without prior fork changes match upstream exactly.
PR #72 incorporates the merge and compatibility repairs into fork `main`.
Compatibility repairs use upstream's repository-root and host-classification APIs,
and carry project-scoped text generation through the shared Git/Jujutsu workflow.
[^november-11-main-git][^november-11-candidate][^november-11-upstream]

Keep upstream's native OpenCode goals, todos, image jobs, shell jobs, and overflow
compaction alongside the fork's reused-child execution safeguards and read-only
Codex subscription limits. Upstream's empty Git-menu guard must still allow the
fork's Enable Jujutsu action. Codex project-root recovery must honor the fork's
configured and previous managed worktree locations.[^november-11-candidate]

The selected tests pass 9,449 cases. Four full-app browser failures reproduce on
pristine upstream; the sidebar shortcut failure and five desktop settings writes
blocked by the machine's `/tmp` quota reproduce on fork `main`. Native verification
is blocked by device-hub startup. No tests were weakened or newly skipped, and no
live deployment occurred.[^november-11-candidate]

## Completed November 10 sync

Merge `27d0bb4278` combines fork `main` `f8595a237d` and upstream `8ee7183e6c`,
preserving ancestry. All 335 incoming paths without prior fork changes match
upstream exactly. PR #71 incorporates that merge and compatibility repairs
`b69b4e7090` into fork `main`; no live deployment occurred.
[^november-10-main-git][^november-10-candidate][^november-10-upstream]

Adopt upstream's default-branch push guard through the existing shared Git/Jujutsu
change-request reads; do not restore the old Git-only PR implementation. Keep
Cursor's VCS hint alongside upstream's interrupted-prompt recovery. SSH retains
owned Portless forwards and external-server readiness guards while adopting
upstream's home-wide launch lock and separate connection/readiness waits.
[^november-10-candidate]

The sibling-discovery path also needs the live-PID readiness guard. Its added
case failed before the guard because the launcher tried a replacement, then
passed with the other four real-process recovery cases.[^ssh-sibling-recovery]

Production web/server/desktop builds and scoped adaptation checks pass. The
final changed-file suite passes 4,331 tests; its three full-app browser failures
and the SQLite performance test's missing
`statement.stat` method reproduce on pristine upstream. Native device verification
remains blocked by device-hub startup; no live deployment has occurred.
[^november-10-candidate]

## Completed November 9 follow-up

[PR #69](https://github.com/NicholasZolton/t3code/pull/69) merged at
`7a0869df09c91d721d7b77565bbe8cab2c0f0bf1` on November 9, 2026,
at 17:18:10 UTC. It retains fork parent `7265fa73f4` and integrated branch tip
`fd06a4b7aa`; all 48 incoming upstream commits are now ancestors of fork `main`.
[^november-9-followup-main][^november-9-followup-main-git]

Merge `82fe80c22ec4c40f51e29951a0bc42d066da1861` combines fork `main`
`7265fa73f437c896336820dd6146010e1897bc97` and upstream
`7b248349bdc066b1488f52083662597ab22d6fe3`.
Of 275 incoming paths without prior fork changes, 273 match upstream exactly.
The exceptions retain fork search ranking in upstream's moved shared helper and
cover Jujutsu identity in the new chat-status selector.
[^november-9-followup-candidate][^november-9-followup-upstream]

Changed-file checks pass except three full-app browser failures reproduced on
pristine upstream. Production web/server builds, focused fork regressions, and a
real-client onboarding/Replay/model-mention pass succeed. Native verification is
blocked by device-hub startup, and no live deployment has occurred.
[^november-9-followup-candidate]

Adopt upstream's single Welcome page, external MCP setup, model mentions,
Legend List upgrade and removed workarounds, mobile terminal and feed fixes,
and provider lifecycle fixes. Preserve Vim's literal editor alongside model
mentions, saved prompts, fuzzy search, Git/Jujutsu terminology, and paired
notification boundaries. The shared awareness-phase helper remains callable by
paired notifications while accepting upstream's child-approval signal.
[^november-9-followup-candidate]

## Completed November 9 sync

[PR #68](https://github.com/NicholasZolton/t3code/pull/68) merged on November 9,
2026, at 06:58:06 UTC. Its landing commit
`2d55bfc6f46b5fb508f063ad57f73cdf0a6b8535` preserves previous fork `main`
`19474d8c52d9c558472d51a4456a25eb08fcf19e` and integrated branch tip
`87eecdc25518d90b0786dfa0f0d842b3dce7aebe` as parents.
[^november-9-main-integration][^november-9-main-review-git]

Initial merge `fcf161aee52d30da2fb9607d9ae5893e15bd6b59` combines fork `main`
`19474d8c52d9c558472d51a4456a25eb08fcf19e` with upstream `c4ce7b0fd7`.
Follow-up merge `e5f32987d0e27564e7edf043e9502e3aa2e12f03` preserves it and
incorporates upstream `5ee1dbffbea1c3e2930f6512a99e81e8c4ecc3c4`.
Both merges and all 95 incoming commits are now ancestors of fork `main`.
Of 545 incoming paths without prior fork changes, 543 match upstream exactly;
two mobile branch-sheet fixtures supply the fork's VCS terminology. Changed-file
checks pass except a full-app draft browser timeout reproduced on clean fork
`main`; native clients remain unverified.
[^november-9-local-integration][^november-9-latest-integration][^november-9-upstream]

Adopt upstream's checkout cache, collision-resistant worktree names, cheaper branch
reads and cleanup scans, text generators, mobile UI primitives, and legacy
plan-mode removal. The sync also adopts native mobile DPoP signing, Cursor
Origin, and marketing locales.
Keep project grouping and flat worktree layouts around upstream
creation, and keep the Jujutsu exclusion in upstream's shared cleanup-path guard.
Android activity remains independent of ordinary alerts, including paired sources;
out-of-order completion deduplication and encrypted delivery remain fork boundaries.
[^november-9-local-integration]

## Completed November 7 sync

[PR #59](https://github.com/NicholasZolton/t3code/pull/59) merged on November 7,
2026, at 17:07:59 UTC. Its landing commit
`703297e186f1f269c7ff11a20e34584b16b4e786` preserves previous fork `main`
`c0bde3fa7067faa6ad3c8c5477e701199f0888e3` and integrated branch tip
`f7aa77732c5d52f9b08bf8c9e8afc74ca73d0250` as parents.
[^november-7-main-integration][^november-7-main-review-git]

Merge `6087079d9d4297ea5f9681c397691a962b49c875` preserves fork parent
`c0bde3fa7067faa6ad3c8c5477e701199f0888e3` and upstream parent
`e455200077ce60806a01c8f28435b58860dcfc74`. Follow-up
`69a4603d988dc1ed30d9c1c85ad6e1892ceeab53` retains that merge unchanged.
Of 1129 incoming paths without prior fork changes, 1127 match upstream exactly;
the two exceptions keep fuzzy ranking in upstream's new shared reviewer filter.
All reference repositories match upstream. Realigning stale merge leftovers to
upstream shrank the fork's divergence from 415 to 414 files.
[^november-7-local-integration]

Adopt upstream's mobile AppBar and route presets, fresh sessions (`/clear`),
dictation, secret providers, and Android one-alert-per-completion behavior.
Keep Jujutsu, prompts, Vim, fuzzy menus, diff shortcuts, paired notifications,
worktree settings, and SSH shutdown. Upstream status reads now confirm the
branch on every cache hit, so Jujutsu's branch check must stay one `jj log`
rather than a full status, which snapshots the working copy. Paired
notifications merge sources out of order, so the upstream completion dedupe
keeps a set of covered finishes, pruned at card expiry, instead of one key.
[^november-7-local-integration]

## Completed November 5 sync

[PR #56](https://github.com/NicholasZolton/t3code/pull/56) merged on November 5,
2026, at 06:13:56 UTC. Its landing commit
`53b9557983f2d9ab935abd96d63c8098f91917f3` preserves previous fork `main`
`9bcf77bb7083eb03de5f71cf220d5bfdf6940a45` and integrated branch tip
`48fbc5858a399afac714159811a728109c38f88a` as parents.
[^november-5-main-integration][^november-5-main-review-git]

Merge `1c01e0f4cab7d60cdc8ec35e41df586d6dc2a388` preserves fork parent
`9bcf77bb7083eb03de5f71cf220d5bfdf6940a45` and upstream parent
`67eebaca23f8f7bc46e8817434087fc9c5acf8e3`. Follow-up
`cc28dd559547b93bd6c66727b60987d631aa26c9` retains that merge unchanged.
Of 543 incoming paths without prior fork changes, 542 match upstream exactly;
the only exception marks the relay-consumed key importer as public for scoped
export analysis. All reference repositories match upstream.
[^november-5-local-integration]

Adopt upstream's crypto/signing services, typed errors, Effect checker, deferred
diff loading, editable Markdown composer, and new project-folder layout. Keep
fork diff shortcuts, Vim, prompts, mixed Git/Jujutsu recovery, paired notifications,
OpenCode reused-child safeguards, SSH readiness guards, Crit/Portless, and signing
identities. Fork helpers follow the new Effect rules instead of disabling them.
Jujutsu workspace roots must be available on disk even when newer `jj` versions
report the historical path of a deleted workspace.
[^november-5-local-integration][^workspace-recovery][^opencode-child-tracking]

## Completed November 4 sync

[PR #55](https://github.com/NicholasZolton/t3code/pull/55) merged on November 4,
2026, at 07:28:58 UTC. Its landing commit
`0406c1c1be2fe50e8ea78df42febd3919481d750` preserves previous fork `main`
`470e518f7760790cae1e2fbb1e40fb1c30d4791a` and final code tip
`e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa` as parents.
[^november-4-main-integration][^november-4-main-review-git]

Merge `865f3f977091580bc9e72236d7b042d617b2d1c1` preserves fork parent
`470e518f7760790cae1e2fbb1e40fb1c30d4791a` and pinned upstream parent
`3368dd70f20cb192b68895494a4a73455524fb76`. Follow-up adaptations through
`9b7bee668b6fd6d210c57fef622daac4c28293dd` and the OpenCode usage retirement in
`e530c7f948b2c88ba0dd04f930b9e72ade3aa3aa` retain the merge unchanged.
The initial branch snapshot had zero upstream gap while fork `main` still lacked
those 351 commits; PR #55 subsequently closed that gap on `main`.
[^november-4-local-integration][^november-4-review-git][^november-4-upstream]

Use upstream's Effect 4.1.2 crypto services and mobile AppBar settings menus for
fork-only notification, Jujutsu, and prompts code; do not restore the removed
APIs. All reference repositories and 1,155 of the 1,156 incoming paths without
prior fork changes match upstream exactly. The sole exception adds scanner
coverage for Jujutsu checkout discovery and managed worktree locations.
[^november-4-local-integration][^november-4-review-git]

Retain unreplaced fork prompts/Vim, Git/Jujutsu ownership and shared recovery,
reused OpenCode child-input safeguards, paired notification privacy and local
Settings access, SSH readiness guards, Crit/Portless, and private signing.
These remain compatibility boundaries around upstream implementations, not
parallel replacements for the services upstream now owns.
[^november-4-local-integration][^workspace-recovery][^opencode-child-tracking]

## Completed November 2 sync

[PR #52](https://github.com/NicholasZolton/t3code/pull/52) merged on November 2,
2026, at 04:27:11 UTC. Its landing commit
`9a73f5dd047b5a63069cb8350863f6a35f2735a2` preserves previous fork `main`
`c98f21e930f67ead4aac04137b2a0e1398849b0a` and integrated branch tip
`892da10b7eee5193eba7393fa091113833b94c7a` as parents.
[^november-2-main-integration][^november-2-main-review-git]

Merge `ed52b86b6a9ffb6afad94980cc3d7d8cb5c851aa` has parents reused integration
`e7d7a393d980059c14fc65f2892f6b04112bf06f` and pinned upstream
`dd6c05ec313c6c870c7a7688e87143da5084031d`. The reused merge already contains
fork `main` `c98f21e930` and upstream `18e2742519`; both integrations are retained
in ancestry rather than replayed or squashed. Follow-up repairs through code tip
`1a21e4d0e6` leave the merge hash unchanged. The initial branch snapshot had
zero upstream gap while fork `main` still lacked those 3,337 commits; PR #52
subsequently closed that gap on `main`.
[^november-2-local-integration][^november-2-review-git][^november-2-upstream]

Use upstream's thread-search ranking, mobile list/review extraction,
provider-workspace refresh atoms, root-route settings navigation, and source-control
definitions and hooks. Retain fork fuzzy matching outside thread searches; do not
restore the old thread scorer. Git and Jujutsu share the upstream-compatible
change-request workflow rather than separate GitHub-specific helpers.
[^november-2-local-integration][^shared-pr-workflow]

Unreplaced fork behavior remains: saved prompts, Vim, OpenCode account controls
and child-input tracking, notification privacy, Jujutsu, SSH readiness safeguards,
Crit/Portless, persistent Tailscale publication, and private signing.
Missing-workspace recovery stays at the shared workflow boundary and respects the
recorded backend owner instead of silently switching Git/Jujutsu ownership.
[^november-2-local-integration][^workspace-recovery][^opencode-child-tracking]

Composer scroll-collapse is upstream's, not the fork's. Upstream removed it with
its setting, so syncs keep it removed; this merge had kept it as fork behavior.
[^composer-collapse-removal]

## Completed October 16 sync

[PR #50](https://github.com/NicholasZolton/t3code/pull/50) merged on October 16,
2026, at 14:31:00 UTC. Its landing commit
`d3b3491750d65d0ddfc8bd1b192c616005560d64` preserves previous fork `main`
`f2d43354c9acdd8b2ecd777afa8fb9103ff336fb` and integrated branch tip
`80c7adc76b539ce0240aa541d8a1a0c83d23d5a2` as parents.
[^october-16-main-integration][^october-16-main-review-git]

Merge `837d227b910791a9f9c28c6fea2609af3f40085c` has fork parent
`f2d43354c9acdd8b2ecd777afa8fb9103ff336fb` and upstream parent
`3962ae8586333310eeef655c917389b35f7b679d`. Both parents are incorporated into
fork `main`; the sync was not squashed. Main integration is not a remote deployment.
[^october-16-branch-integration][^october-16-main-review-git]

Adopt upstream v0.1.0/Beta branding, mobile shared controls, stable callback
handling, provider fixes, live command output, and database maintenance. Fork
mobile screens use upstream's reorganized UI components and dialog presenter;
prompts, Vim, shortcuts, account controls, paired notifications, Crit/Portless,
SSH guards, and mixed Git/Jujutsu behavior remain. Model search uses the fork's
shared scorer with position-independent matching to retain upstream's newest-first
ties, rather than duplicating scoring logic. All 669 incoming paths without prior
fork changes match upstream exactly.[^october-16-review-git][^october-16-upstream]

## Completed October 15 sync

[PR #48](https://github.com/NicholasZolton/t3code/pull/48) merged on October 15,
2026, at 14:32:29 UTC. Its landing commit
`9ce8f0a504b8abe1af9feead20ae1714c0d9ded8` preserves previous fork `main`
`e9e7b07c0dfdc421d4216b2164cd4efe4ec4588d` and integrated branch tip
`d3b9e1b76e9815a6dfae066d85a272f24c81536d` as parents.
[^october-15-main-integration][^october-15-main-review-git]

Merge `30b7fbff813e913ac3b88ae58ebe1dd47b50fc4f` has fork parent
`e9e7b07c0dfdc421d4216b2164cd4efe4ec4588d` and upstream parent
`e536bfd33bc3c351997141d93790df75eeded7b9`. Both parents are incorporated into
fork `main`; the sync was not squashed. Main integration is not a remote deployment.
[^october-15-branch-integration][^october-15-upstream][^october-15-main-review-git]

Adopt upstream's managed SSH recovery and ownership cleanup. Keep the smaller
external/discovered readiness guards described below, plus Jujutsu recovery,
OpenCode execution tracking and account controls, saved prompts/Vim,
Crit/Portless, and paired notifications. Upstream-only incoming paths match
upstream except for required keybindings in two composer tests.
[^october-15-review-git]

## Completed October 14 sync

[PR #47](https://github.com/NicholasZolton/t3code/pull/47) merged on October 14,
2026, at 15:39:28 UTC. Its landing commit `65729a46467ede150ca3b42ad34f58e9f23d027f`
preserves previous fork `main` `1a005f7db369b60533d98ef63177cf03e765b50d` and
integrated branch tip `ba5362c81a1082db1eac60f0d666ea8380474d7c` as parents.
[^october-14-main-integration][^october-14-fork-main]

Merge `24ab07ed900d70c4fac0e06c58262d818e202753` preserves fork parent
`1a005f7db369b60533d98ef63177cf03e765b50d` and upstream parent
`11fd54fcbbfb39f824bb4c908d428c20d801267c`. Follow-up merge
`2f17f4f635e021d775c0f6c1ebe030bcba0f5d55`, with branch parent
`0a5dafd0eb94641d642324c727ed1c9683556c43` and upstream parent
`6002c5c68c637de2cd2557bd6c40e46c153e39b1`, includes the usage-source label fix
published during final validation. Both merges are incorporated into fork `main`;
the sync was not squashed. Main integration is not a remote deployment.
[^october-14-branch-integration][^october-14-main-review-git][^october-14-upstream]

Upstream's generic dropped-settings detection replaces the fork's web worktree-only
check and separate ignored-write result. Both web implementation paths now match
upstream exactly; retain the mobile worktree warning, which upstream still does not
provide. Inline slash skill search coexists with saved prompts, and the macOS autofill
opt-out coexists with held-key repeat. Delegated worktree isolation uses upstream's
launch service, retaining the fork's configurable temporary branch prefix and
Git/Jujutsu provisioning boundaries.[^october-14-review-git]

The incoming range does not replace the SSH recovery or reused OpenCode child
execution safeguards. Keep those exceptions, account controls, prompts/Vim, Crit
forwarding, and paired Android delivery. Upstream-only incoming files remain
unchanged except for using the runner's `GITHUB_EVENT_PATH` instead of shell-template
interpolation in the webhook workflow; the imported retry behavior is unchanged.
[^october-14-review-git]

## October 13 main sync

[PR #46](https://github.com/NicholasZolton/t3code/pull/46) merged on October 13,
2026, at 05:38:02 UTC, landing at `eb4dc2fd6e`.
[^october-13-main-integration][^october-13-fork-main]

Merge `801585a0bd383420165e9139e323ee67f6507a9a` preserves fork parent
`373e85e76687ec991b5fb4e7b6c47b46ff676e1e` and upstream parent
`5070a83a3248c537d3baaf063e719f179c49bb52`. Both parents are incorporated into
fork `main`; the sync was not squashed. Main integration is not a remote deployment.
[^october-13-integration][^october-13-review-git]

Adopt upstream's PR cache, connection recovery, provider outcomes, secret handling,
prompt links, client fixes, and mobile dependencies. Keep the fork's shared
Git/Jujutsu PR workflow: each adapter normalizes saved PR bases to a named branch
or bookmark, so upstream's checkout-revision fix applies in both lanes without
duplicating the workflow. Upstream-only paths remain unchanged apart from the
Git-action test fixtures needed for fork VCS discovery.[^october-13-integration][^shared-pr-workflow]

This upstream range changes neither OpenCode's adapter nor SSH recovery. Claude's
child-outcome fixes do not replace the reused OpenCode execution safeguard below.
Preserve those exceptions and the other unreplaced fork behavior.
[^october-13-upstream]

The active-tool collection optimization (`540a3e89ed`) and pace-icon alignment
fix (`e9221e44da`) were excluded from PR #46. They are now included in the completed
October 14 sync on fork `main`.
[^october-13-newer-upstream][^october-14-main-review-git]

## October 12 main sync

[PR #44](https://github.com/NicholasZolton/t3code/pull/44) merged on October 12,
2026, at 06:03:14 UTC, landing at `f4a2d2472c`.
[^october-12-main-integration][^october-12-fork-main]

Merge `eec69e1928b4aadf52e78fd2b14f9df6aa1f5f44` preserves fork parent
`e373457c74fd6b224a9019c4d8c20c6fa06fe7d9` and upstream parent
`e688034b5f5505f92fcf1d78ba853c9c0107f9f1`. Both parents are incorporated into
fork `main`; the sync was not squashed. Main integration is not a remote deployment.
[^october-12-branch-integration]

The sync adopts upstream's extracted provider and source-control packages,
legacy provider-settings removal, desktop main-contents commands, and Git-only
storage cleanup. Fork features use those upstream boundaries rather than parallel
implementations. Jujutsu cleanup and reused OpenCode child sessions retain the
compatibility exceptions below.[^october-12-branch-integration]

## Previous main sync

[PR #37](https://github.com/NicholasZolton/t3code/pull/37) merged on October 8,
2026, at 18:49:13 UTC, landing at `e5365adddc`.
Merge `2bc0f738329c83c0a7e146018d640a512634f876` preserves ancestry from fork
`e4b289c26c` and upstream `9a3070bcf0`. Both parents are incorporated into fork
`main`; the sync was not squashed. Main integration is not a remote deployment.
[^october-8-main-integration][^october-8-fork-main][^october-8-integration]

The sync adopts upstream's `worktreesDirectory` setting, Storage control,
path validation, and previous-location tracking. Saved fork `worktreeDirectory`
values migrate on load; an explicitly saved upstream value wins. Retain the
fork's canonical-checkout grouping: `<location>/<original checkout>/<worktree>`,
even when creating from a linked worktree. The optional flat layout and custom
temporary branch prefixes remain. Defaults use upstream's `t3/` prefix and its
namespace-collision fallback; existing legacy names stay recognized.
[^october-8-integration][^upstream-worktree-location]

Workspace discovery now uses upstream's provider registry and five-minute
freshness/refresh policy across clients. The old fork catalog helper and
`invalidateWorkspaceSnapshots` API are removed, rather than maintained as a
parallel refresh path. Preserve the unrelated fork boundaries below, including
mixed Git/Jujutsu recovery, SSH reconnect preservation, configured OpenCode
permissions and reused-subagent tracking, prompts, Vim, accounts, Crit/Portless,
and private Android signing.[^october-8-integration][^upstream-skill-refresh]

## Previous upstream sync

[PR #34](https://github.com/NicholasZolton/t3code/pull/34) merged on October 5,
2026, at 20:00:02 UTC, landing at `2586800144` with no ancestry gap against
`1604ccc9d7`.[^october-5-main-integration][^latest-review-git]

Merge `ab7e864a1aa3ce44d99454b8e363297227475ead` preserves upstream ancestry,
with fork parent `9064bb3d8e` and upstream parent `1604ccc9d7`. The branch also
incorporates fork `main`'s docs-only remote-deployment update. Both parents are
incorporated into fork `main`; the sync was not squashed.
[^october-5-candidate][^october-5-fork-main][^latest-review-git]

The maintainer chose upstream's MCP implementation in full: explicit targets,
external callers, cross-project access, and caller permission ceilings replace
the fork's none/project/environment access policy and its settings. Future syncs
should not restore that parallel policy. This sync combined fork catalog freshness
with upstream incomplete-discovery retries; the October 8 sync replaces that
combined implementation with upstream's newer refresh policy. Upstream OpenCode
parser and permission helper tests replaced the overlapping fork-only attachment test.
[^upstream-mcp-targeting][^october-5-candidate-decisions]

Unrelated fork behavior remains: Jujutsu, reusable prompts, Vim, configured
OpenCode permissions, accounts and defaults, quota weights, Crit/Portless,
worktree configuration, and remembered Tailscale publication. The OpenCode
compatibility exception below remains necessary; the Jujutsu source PR is still
closed without merging into upstream `main`.[^october-5-candidate-decisions][^upstream-jujutsu]

## V2 history and protocol boundary

Merge `696fd65db117198476ad840ca41c4af031b086c4` has parents fork
`0a5b85436bc8fcd26b2ddb126b8c6e6c5818f190` and upstream
`65731f986ba2175063b0182deb6a143f8f323b74`. Both parents are incorporated into
fork `main`; the sync was not squashed. It adopts upstream orchestrator V2,
native OpenCode 2, and the new thread/project MCP services.
[^current-integration][^current-fork-main]

The maintainer chose upstream's legacy import: old messages and metadata survive,
but pre-upgrade checkpoints, tool history, and native sessions do not. First
continuation starts a fresh provider session with bounded handoff context. Rewind
and edit-with-files-kept apply to new V2 turns. Protocol 2 requires matching web,
desktop, mobile, and server versions; coordinate the SSH server restart with active
remote turns.[^upstream-v1-cutover][^upstream-protocol]

That sync retained provider-configured OpenCode permissions, model
defaults, account switching and quota weights, reusable prompts, Vim, mixed
Git/Jujutsu recovery and checkpoints, Crit/Portless, phone pairing identity, and
SSH release handoff. Upstream now owns
native OpenCode 2 and thread management; removed V1 adapters and the old plural
thread toolkit are replaced by those upstream services. The legacy worktree prefix
migrates to upstream branch naming while preserving temporary branch names. The integration was verified against isolated state.

## Last completed main integration

| Item                                               | Recorded value                           |
| -------------------------------------------------- | ---------------------------------------- |
| Fork                                               | `NicholasZolton/t3code`, remote `origin` |
| Upstream                                           | `pingdotgg/t3code`, remote `upstream`    |
| Main landing commit                                | `fee9ab51a2`: merge of PR #73            |
| Upstream integration commit                        | `f792c33025`: merge through `371963ce0b` |
| Fork-side parent                                   | `0827e63928`                             |
| Upstream-side parent / shared baseline             | `371963ce0b`                             |
| Missing commits at that integration's upstream tip | **0**                                    |

Default to upstream implementations. Retain fork code for explicit features
or fixes upstream does not provide. Native OpenCode 2 and thread management now
use upstream services; fork configuration and UI improvements remain layered on
those paths.[^november-12-candidate][^november-12-main-git]

## Earlier integration boundaries

[PR #32](https://github.com/NicholasZolton/t3code/pull/32) merged on October 3,
2026, at 19:59:31 UTC, bringing all 60 reviewed commits through `65731f986b`
into fork `main` at `a9b81ef5c5`, with zero gap against that older tip.
[^current-main-integration][^current-git-history]

[PR #27](https://github.com/NicholasZolton/t3code/pull/27) merged on October 2,
2026, at 06:32:19 UTC, bringing all 50 reviewed commits through `99e08526e5`
into fork `main` at `60e0650513`. Its upstream merge was `24d2e49fd9`.
[^main-integration][^integration-commit][^git-history]

![Previous PR 27 integration boundary](assets/upstream-integration.svg)

[Historical Mermaid source](assets/upstream-integration.mmd)

[PR #21](https://github.com/NicholasZolton/t3code/pull/21) merged at September 30,
2026, 05:57:39 UTC (September 29 in Pacific time), bringing the 81 previously
missing upstream commits through `0fcd5f9061` into `main` at `3da3d19cc2`.
Its upstream merge was `d8353ce56e`.[^previous-main-integration]

The September 25, 2026 sync was `bd57816184`, completed at
19:39:18 −07:00, through upstream `6530de0339`. Earlier that day,
`2ee019f626` integrated native OpenCode v2 on upstream `7a12aff471`; the later
sync added 18 upstream commits.[^previous-integration][^native-v2-integration]

The September 27 candidate `a8df093eb6`, with parents fork `af25cb3127` and
upstream `d15210cd3d`, never reached main. It covered 53 of the 81 commits
subsequently included by PR #21. The other 28 were newer than that candidate.
Do not treat the candidate as a completed integration.[^unmerged-candidate][^git-history]

The [integrated range](https://github.com/pingdotgg/t3code/compare/6530de0339d2ca49957d0039133c49e3a08557f7...0fcd5f90611451cca842689faea53b5450c022da)
includes performance and provider lifecycle fixes, background queued-message
sending, mobile improvements, managed ChatGPT/Codex authentication, Codex 0.159
bindings, Sonnet 5.5 metadata, Bitbucket credentials, keyboard latency work,
OpenCode Go account deduplication, and releases 0.0.43 and 0.0.44.

## OpenCode compatibility boundary

The November 15 removal retires the fork's provider-managed permission
override. OpenCode follows T3's thread permission modes; the provider settings
form no longer offers a separate Permissions control. Existing saved override
values are ignored on load, without a settings migration. Deployment remains
separate.[^opencode-permissions-retirement]

At the completed `99e08526e5` sync, upstream marked OpenCode v2
incompatible while this fork supported it natively. Fork #18 removed that
advisory, and PR #27 retained the bundled policy and remote metadata filter.
That protection still matters at the newly reviewed tip.[^main-integration][^integration-commit]

Upstream `65731f986b` supplies the native OpenCode 2 implementation, tested
against 2.0.18. The completed integration adopts its 2.0.18+ baseline, including the installed
2.0.22 CLI, and removes the obsolete fork V2 adapter. The bundled policy enables
that baseline starting at this fork's package version 0.0.45, rather than waiting
for upstream's 0.0.46 threshold. Remote compatibility metadata still cannot replace
the bundled OpenCode policy. Older 2.x versions are outside the supported baseline.
[^upstream-current-manifest][^reviewed-upstream-main]

The completed integration through `3368dd70f2` retains fork admission, execution,
and persisted input-delivery tracking for reused OpenCode child sessions. Once a
child is reused, ambiguous parent reports must not attach stale results or settle
the new call; observed execution can settle it without a result. Preserve this
safeguard until upstream can attribute reports to individual runs.
[^november-4-local-integration][^opencode-child-tracking]

The separate OpenCode account views, credential-file reader, and switching RPCs remain
retired. The fork now restores only the selected ChatGPT/Codex subscription in the
shared Limits view: OpenCode's authenticated API owns connection selection, and T3
reads the subscription without rotating tokens or activating credentials. Keep this
account separate from OpenCode Go limits; it must not change routing or apply Codex
exhaustion to unrelated OpenCode models. Preserve this read-only boundary during syncs.
[^november-4-opencode-usage-removal][^opencode-codex-limits-restoration]

## Jujutsu migration boundary

The fork selectively ports [upstream #13816](https://github.com/pingdotgg/t3code/pull/13816)
with additional recovery safeguards. New isolated threads inherit the project's backend;
existing Git worktrees remain Git, including after cleanup and recreation. Ownership is
recorded in shared Git config rather than a new thread field. A colocated main checkout
and Jujutsu 0.42.0 or newer are required on each server host.[^upstream-jujutsu][^fork-jujutsu]

Preserve this mixed-backend boundary during future syncs. The
[architecture notes](../docs/internals/jujutsu.md) explain checkpoint preservation and
explicit ref synchronization; the [user guide](../docs/user/source-control.md#jujutsu-repositories)
covers enabling Jujutsu and disabling VCS agent hints globally or per project.

The completed October 12 sync uses upstream Git-only storage cleanup and retains every
Jujutsu workspace instead of maintaining a separate automatic removal path.
Jujutsu checkpoints still pin native snapshots: they lack the extra Git checkpoint
commit's capture-time HEAD metadata, so authored-path filtering stays disabled and
turn diffs retain all changes. Snapshot capture and restore remain available.
[^october-12-branch-integration]

## SSH runtime release handoff

The [SSH deployment helper](../scripts/deploy-ssh-runtime.sh) accepts an optional
previous runtime version, for example `bash scripts/deploy-ssh-runtime.sh
<host> <project-directory> 0.0.42` when installing 0.0.44. It updates only the
managed launcher whose process uses that exact installed runtime, preserves
the previous archive, and restores the launcher if startup fails. Coordinate
the restart with active remote turns. Its readiness check covers loopback only,
not the phone-facing Tailscale endpoint.[^ssh-deployment]

Nicholas's remote server, `nicholas-dev`, does not use this helper. It runs the `t3 up` boot
service, which the [remote deployment checks](../AGENTS.md#remote-deployment-checks) switch with
the new runtime's `t3 service install`. The Linux archive's `libatomic` step needs Linux tools;
the 2026-11-07 deploy from the Mac ran that step in an Ubuntu container.[^remote-deployment-checks]

Tailnet publication must be remembered in the running server's state directory
so restarts restore forwarding to its actual listener. A standalone Tailscale
Serve mapping is not sufficient. Follow the [remote deployment checks](../AGENTS.md#remote-deployment-checks)
and require the original HTTPS endpoint to return the same environment ID after
deployment or rollback.[^remote-deployment-checks][^tailscale-persistence]

## SSH recovery exception

Upstream `e536bfd33b` now separates stale-tunnel cleanup from remote shutdown
and preserves an unresponsive managed server. The main integration adopts that recovery
and upstream's ownership cleanup, including replacement when an adopted server
demonstrably exits during handover.[^upstream-ssh-recovery][^october-15-review-git]

Keep the fork's remaining readiness guards: a discovered server with a live PID,
or a remembered external endpoint without proof of exit, must not be replaced
merely because readiness times out. This avoids starting competing servers
against the same T3 home. Explicit Disconnect, desktop shutdown, and requested
managed-runner changes retain their existing behavior.[^ssh-recovery]

Another alias's launch record counts as discovery even before the server publishes
`server-runtime.json`; recheck its PID after a failed readiness probe before
allowing a replacement.[^ssh-sibling-recovery]

The guards retain the remaining protection associated with issue #15608; do not
restore the older parallel managed-server recovery implementation.
[^ssh-recovery-issue][^october-15-review-git]

## Crit remote review boundary

Crit's frontend assumes its own origin root, so tailnet reviews use a separate,
temporary HTTPS endpoint rather than a subpath of the T3 server. Preserve
foreground Serve ownership: closing a review must remove only its endpoint,
never the environment's persistent publication or another review. This branch
supports Tailscale connections alongside SSH/Portless; T3 Connect-only forwarding
is outside that boundary. Crit has no application authentication, so these endpoints
must remain tailnet-only, not Funnel publications.[^crit-tailnet-forwarding][^tailscale-foreground-serve]

Existing file shares can require elevated Serve access even for a proxy-only
change. On Unix, retry permission failures with non-interactive `sudo -n`;
never change the host's operator settings or persistent routes to open a
review.[^crit-tailnet-forwarding]

## Private Android signing identity

Installable private fork APKs use one persistent signing key, stored age-encrypted
in the repository's fnox `local` profile. Preserve that key during future syncs;
replacing it or shipping a debug-signed APK prevents in-place updates to existing
private installations. The user-level age identity remains outside the repository,
and official/EAS signing stays unchanged. See the [signing procedure](../docs/operations/android-notifications.md#private-fork-apk-signing).
[^private-android-signing]

## fnox secrets for provider processes

fnox loads secrets from a shell prompt hook, which never runs when the desktop app
starts or when T3 probes the login shell. At startup, the server runs
`fnox export` from the home directory in the background, so a project's
`fnox.toml` never applies server-wide. It adds only names the server did not
inherit. Provider processes then see the user-level secrets a new terminal would,
such as tokens expanded in `.mcp.json` headers. Keep the `hydrateFnoxSecrets`
call next to `fixPath` in `server.ts` when integrating upstream. Secrets stay in
the server process and never enter the desktop shell snapshot or its disk
cache.[^fnox-provider-secrets]

## Tailscale IPv4 addresses for linked environments

Linking sends a pairing code, then a bearer token, to the peer, so `PeerLinks`
refuses plain http unless the network encrypts it. Upstream allows only loopback,
MagicDNS names and Tailscale IPv6 there, and refuses a bare `100.64.0.0/10`
address because carrier-grade NAT shares that range. That made linking from
`nicholas-dev` to a desktop impossible: the desktop advertises its Tailscale
IPv4 address, and `nicholas-dev` resolves no MagicDNS names. The fork also
accepts a `100.64.0.0/10` address that the linking machine's
`tailscale status --json` lists for itself or a peer. Without a working
`tailscale` CLI the address stays refused. Keep `encryptsPlainHttp` and
`readTailscaleNodeAddresses` when integrating upstream peer-link
changes.[^tailnet-peer-links]

## Searchable All projects row

Upstream hides the sidebar project filter's "All projects" row once a search
query is typed, so it can never lead the results under auto-highlight. The fork
ranks that row by its label like every project row, so typing "all" finds it and
Enter clears the project scope. A project whose name matches the query better
still leads. Keep "all" in the items `filterSidebarProjectScopeItems` ranks when
integrating upstream sidebar filter changes.[^sidebar-all-projects-search]

## Default app in the Open-in picker

The fork adds a "Default app" item to the Open-in picker when it targets a file
on a local-exec environment. It calls the existing `file-manager` editor without
`reveal`, which hands the file to the host's default app. It opens right away
and never becomes the favorite editor, so the contracts and server stay
unchanged. Keep the item when integrating upstream picker
changes.[^open-in-default-app]

## Opt-in pull request approval waits

Upstream (`36254ab82`) stops a watched pull request from holding its thread
once every check finishes, even while review is pending, so forgotten watches
cannot keep completed work in Working indefinitely.
[PR #83](https://github.com/NicholasZolton/t3code/pull/83) preserves that default
and adds an optional `waitForApproval` setting. An opted-in watch holds until
checks finish and the host reports `approved`, including bot approvals without
mandatory-review rules. Approval releases the hold without ending the watch.
Keep the opt-in separate from the default checks-only policy when integrating
upstream watch changes.[^pr-watch-review-hold]

## Rechecking the boundary

After fetching `origin main` and `upstream main`, use ancestry to identify the
active baseline and gap. `--is-ancestor` exits 0 when incorporated and 1 when
absent.

```bash
git rev-parse origin/main upstream/main
git merge-base origin/main upstream/main
git merge-base --is-ancestor 696fd65db1 origin/main
git merge-base --is-ancestor ab7e864a1a origin/main
git merge-base --is-ancestor 2bc0f73832 origin/main
git merge-base --is-ancestor eec69e1928 origin/main
git merge-base --is-ancestor 801585a0bd origin/main
git merge-base --is-ancestor 2f17f4f635 origin/main
git merge-base --is-ancestor a8df093eb6 origin/main
git rev-list --count origin/main..upstream/main
git log --reverse --oneline origin/main..upstream/main
```

[^november-16-candidate]: Local November 16 ancestry and incoming-path verification, recorded in frontmatter.

[^november-16-main-git]: Completed main integration and preserved ancestry verified against the pinned upstream tip.

[^november-16-upstream]: Pinned upstream revision for the November 16 integration.

[^november-16-verification]: Final local verification and baseline reproductions recorded in frontmatter.

[^november-16-pr]: PR evidence and final compatibility decisions.

[^november-13-candidate]: Exact November 13 merge and compatibility resolutions.

[^november-13-git]: Local ancestry and incoming-path audit against the pinned upstream tip.

[^november-13-verification]: Partitioned local verification and baseline reproductions.

[^november-13-pr]: PR evidence and final compatibility decisions.

[^november-9-followup-main]: PR #69 and its recorded merge time.

[^november-10-main]: PR #71 and its recorded merge time.

[^november-10-main-git]: Completed main ancestry checks and zero gap against the pinned upstream tip.

[^november-10-candidate]: Exact November 10 merge parents, incoming-path audit, and fork compatibility decisions.

[^november-10-upstream]: Exact upstream revision reviewed for the November 10 sync.

[^ssh-sibling-recovery]: Owned HTTP-process fixtures verify refusal without signals or replacement launches, then reuse after recovery.

[^november-9-followup-main-git]: Completed main ancestry checks and zero gap against the pinned upstream tip.

[^november-9-followup-candidate]: Ancestry-preserving follow-up merge and upstream-only source audit before main integration.

[^november-9-followup-upstream]: Exact upstream revision reviewed for the November 9 follow-up.

[^november-9-main-integration]: PR #68 and its recorded merge time.

[^november-9-main-review-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-9-local-integration]: Initial candidate merge ancestry and upstream-only path comparison before main integration.

[^november-9-latest-integration]: Final pinned candidate ancestry and the two incoming test-fixture exceptions.

[^november-9-upstream]: Exact upstream revision reviewed for the November 9 sync.

[^main-integration]: PR #27 and its recorded merge time and verification.

[^integration-commit]: Full upstream merge, its parents, and preserved fork behavior.

[^fork-main]: PR landing commit retaining upstream ancestry.

[^upstream-main]: Exact reviewed upstream revision.

[^previous-integration]: Previous completed sync through upstream 6530de0339.

[^previous-main-integration]: PR #21 and its completed integration through upstream 0fcd5f9061.

[^native-v2-integration]: Earlier native OpenCode v2 integration.

[^unmerged-candidate]: Local-only candidate and its parents; not an ancestor of main.

[^git-history]: Ancestry checks and commit counts against the pinned revisions.

[^ssh-deployment]: Deployment helper's release handoff and startup rollback.

[^remote-deployment-checks]: Agent instructions for preserving and verifying the phone-facing endpoint.

[^tailscale-persistence]: `pair --tailscale` discovers the live server and remembers its HTTPS port for startup restoration.

[^ssh-recovery]: Integrated SSH implementation and its focused readiness-recovery regressions.

[^crit-tailnet-forwarding]: The review manager keeps Crit on loopback and owns each temporary forward's lifetime.

[^tailscale-foreground-serve]: Foreground Serve uses a nested configuration tied to its IPN watcher; closing that session removes its publication.

[^upstream-ssh-recovery]: Exact upstream SSH source supplying managed-server and stale-tunnel recovery.

[^ssh-recovery-issue]: Open upstream issue and its stale-tunnel reconnect reproduction.

[^upstream-jujutsu]: Original upstream support, used as the selective-port source.

[^fork-jujutsu]: Durable backend ownership, recovery behavior, and supported Jujutsu baseline.

[^private-android-signing]: Fork signing policy and the fnox-backed APK signing helper.

[^fnox-provider-secrets]: Startup loading, home-directory scope, and inherited-value precedence.

[^tailnet-peer-links]: The plain-http check in `PeerLinks` and the Tailscale status reader it uses.

[^sidebar-all-projects-search]: The sidebar project filter's search ranking, which keeps the "All projects" row searchable.

[^open-in-default-app]: The Open-in picker's "Default app" item and its local-exec, file-only gate.

[^pr-watch-review-hold]: The watch option and shared completion hold derived from the PR snapshot.

[^reviewed-fork-main]: Exact fork main revision fetched for this review.

[^reviewed-upstream-main]: Exact upstream main revision fetched for this review.

[^latest-review-git]: October 5 completed main ancestry checks, merge time, and zero missing commits against the pinned upstream tip.

[^october-5-main-integration]: PR #34 and its recorded merge time.

[^october-5-fork-main]: Main landing commit retaining the complete upstream ancestry.

[^october-5-candidate]: Full upstream merge with fork parent 9064bb3d8e and upstream parent 1604ccc9d7, now incorporated into main.

[^october-5-candidate-decisions]: Source comparison of the candidate's conflict resolutions and retained fork features.

[^upstream-mcp-targeting]: Upstream MCP caller/target redesign selected instead of the fork access policy.

[^upstream-v2]: V2 replacement and the new provider/orchestration boundaries.

[^upstream-v1-cutover]: Legacy import intentionally excludes checkpoints, tool items, and native sessions; continuation uses bounded context in a new session.

[^upstream-protocol]: Protocol version 2 and client/server negotiation metadata.

[^upstream-current-manifest]: Version-scoped OpenCode advisory at the reviewed tip.

[^current-integration]: Full V2 upstream merge and its fork and upstream parents.

[^current-main-integration]: PR #32 and its recorded merge time.

[^current-fork-main]: Main landing commit retaining upstream ancestry.

[^current-git-history]: Ancestry checks and zero missing commits against the pinned upstream tip.

[^october-8-main-integration]: PR #37 and its recorded merge time.

[^october-8-fork-main]: Main landing commit retaining the complete upstream ancestry.

[^october-8-integration]: Full upstream merge, its exact parents, and retained fork boundaries, now incorporated into main.

[^october-8-review-git]: Completed main ancestry checks and zero missing commits against the October 8 pinned upstream tip.

[^upstream-worktree-location]: Upstream location resolution and managed-directory history selected for the completed sync.

[^upstream-skill-refresh]: Upstream workspace discovery freshness and refresh machinery selected for the completed sync.

[^october-12-main-integration]: PR #44 and its recorded merge time.

[^october-12-fork-main]: Main landing commit retaining the complete upstream ancestry.

[^october-12-branch-integration]: Full upstream merge, its exact parents, and retained compatibility decisions, now incorporated into main.

[^october-12-review-git]: Completed main ancestry checks and zero missing commits against the October 12 pinned upstream tip.

[^october-13-main-integration]: PR #46 and its recorded merge time.

[^october-13-fork-main]: Main landing commit retaining the complete upstream ancestry.

[^october-13-integration]: Completed upstream merge and its exact fork and upstream parents.

[^october-13-review-git]: Completed main ancestry checks, zero gap at the integrated tip, and two newer unmerged commits.

[^october-13-upstream]: Exact upstream revision and unchanged OpenCode/SSH package paths since e688034b5f.

[^october-13-newer-upstream]: Exact newer upstream range excluded from PR #46.

[^shared-pr-workflow]: Shared change-request step with backend-specific saved-base normalization.

[^october-14-main-integration]: PR #47 and its recorded merge time.

[^october-14-fork-main]: PR landing commit retaining upstream ancestry.

[^october-14-main-review-git]: Completed main ancestry checks, exact revisions and parents, and zero gap against the pinned upstream tip.

[^october-14-branch-integration]: Upstream integration merges and their exact parents, now incorporated into main.

[^october-14-review-git]: Initial pre-integration main gap, zero branch gap, preserved compatibility exceptions, and upstream-first conflict resolutions.

[^october-14-upstream]: Exact upstream revision incorporated into the completed October 14 sync.

[^october-15-branch-integration]: Upstream merge and its exact parents, now incorporated into main.

[^october-15-review-git]: Pinned main gap, zero branch gap, source audit, and retained compatibility exceptions.

[^october-15-upstream]: Exact upstream revision incorporated into the completed October 15 sync.

[^october-15-main-integration]: PR #48 and its recorded merge time.

[^october-15-main-review-git]: Completed main ancestry checks, exact revisions and parents, and zero gap against the pinned upstream tip.

[^october-16-branch-integration]: Upstream merge and its exact fork and upstream parents, now incorporated into main.

[^october-16-review-git]: Pinned main gap, zero branch gap, source audit, and retained fork compatibility boundaries.

[^october-16-upstream]: Exact upstream revision incorporated into the completed October 16 sync.

[^october-16-main-integration]: PR #50 and its recorded merge time.

[^october-16-main-review-git]: Completed main ancestry checks, exact revisions and parents, and zero gap against the pinned upstream tip.

[^november-2-local-integration]: Local-only merge objects, exact parents, and upstream-first compatibility decisions; not a main integration.

[^november-2-review-git]: Revision-pinned ancestry checks, zero branch gap, and the separate 3,337-commit gap on unchanged fork main.

[^november-2-upstream]: Exact upstream revision incorporated into the local integration branch.

[^november-2-main-integration]: PR #52 and its recorded merge time.

[^november-2-main-review-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^workspace-recovery]: Shared recovery service preserves backend ownership and retained-branch priority.

[^opencode-child-tracking]: Native OpenCode lifecycle with reused-child admission, execution attribution, and delivery tracking.

[^opencode-permissions-retirement]: The adapter always derives session rules from the thread's runtime policy.

[^composer-collapse-removal]: Upstream #25869 deletes the collapsed composer state and the `composerCollapseOnScroll` setting.

[^november-4-local-integration]: Upstream merge and follow-up API adaptations, now incorporated into main through PR #55.

[^november-4-review-git]: Exact revisions, ancestry, separate main and branch gaps, and upstream-first source comparison.

[^november-4-upstream]: Exact upstream revision incorporated into the completed November 4 sync.

[^november-4-opencode-usage-removal]: Maintainer-requested removal of fork-only OpenCode account usage and switching, preserving unrelated provider behavior.

[^opencode-codex-limits-restoration]: Active subscription reads through OpenCode's API; no account switching, database access, or token refresh writes.

[^november-4-main-integration]: PR #55 and its recorded merge time.

[^november-4-main-review-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-5-local-integration]: Exact local merge and code-tip revisions, initial separate main and branch gaps, and upstream-first source comparison; subsequently incorporated into main through PR #56.

[^november-5-upstream]: Exact upstream revision incorporated into the completed November 5 sync.

[^november-7-main-integration]: PR #59 and its recorded merge time.

[^november-7-main-review-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-7-local-integration]: Exact local merge and code-tip revisions, initial separate main and branch gaps, and upstream-first source comparison; subsequently incorporated into main through PR #59.

[^november-7-upstream]: Exact upstream revision incorporated into the completed November 7 sync.

[^november-5-main-integration]: PR #56 and its recorded merge time.

[^november-5-main-review-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-11-candidate]: Exact candidate parents, code tip, separate main and branch gaps, and upstream-first source comparison.

[^november-11-upstream]: Exact upstream revision incorporated into the November 11 candidate.

[^november-11-main]: PR #72 and its recorded merge time.

[^november-11-main-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-12-candidate]: Exact candidate parents, code tip, separate main and branch gaps, and upstream-only source comparison.

[^november-12-upstream]: Exact upstream revision incorporated into the November 12 candidate.

[^november-12-main]: PR #73 and its recorded merge time.

[^november-12-main-git]: Completed main integration, exact parents, and zero ancestry gap against the pinned upstream tip.

[^november-17-candidate]: Exact candidate parents, code tip, separate main and branch gaps, and upstream-first source comparison.

[^november-17-upstream]: Exact upstream revision incorporated into the November 17 candidate.

[^november-17-verification]: Local verification, corrected Node runtime, passing fixture repairs, and reproduced baseline failures.

[^november-17-followup]: Four newer upstream commits and their scoped verification.

[^november-17-pr]: PR #84 and its uploaded client verification evidence.
