---
upstream: pingdotgg/t3code
sync_tags: v*-nightly.*
check: scripts/fork/check.sh
release: scripts/fork/release.sh
release_on: push
---

# T3 Code fork

Milad's fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), rebuilt from upstream `v0.0.46-nightly.20261010.2908` on 2026-10-10. The pre-reset fork is archived on the `archive/fork-pre-reset-2026-10-10` branch.

Releases are built from `main` on the Mac Mini; installed fork apps download each one in the background and install it the next time the app quits; the in-app update button restarts into it sooner. The desktop app ships as "T3 Code (Fork)": its own bundle id, profile, `~/.t3-fork` state directory, and update feed (prereleases on mimen/t3code, built and signed on the Mac Mini by `scripts/fork/release.sh`). The hourly hub Updates job merges each new upstream nightly tag once a night. Every push to `main` runs `.github/workflows/fork-release.yml` on the Mini's self-hosted runner, which releases it after `scripts/fork/check.sh` passes, so merging to `main` is the whole ship step. Upstream's own workflows are disabled on this repo. Nothing restarts the app on its own. Rules for changing anything here: the `fork` skill.

| Path                                                                      | Why                                                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                               | fork block at the top                                                                                                 |
| `apps/desktop/src/app/DesktopStatePaths.ts`                               | default state directory from `FORK_IDENTITY`                                                                          |
| `apps/desktop/src/app/DesktopUserData.ts`                                 | Electron profile directory from `FORK_IDENTITY`                                                                       |
| `apps/desktop/src/app/DesktopEnvironment.ts`                              | packaged app display name from `FORK_IDENTITY`                                                                        |
| `apps/desktop/src/updates/DesktopUpdates.ts`                              | auto-update: background download and install on quit, so an unclicked button never strands a Mac                      |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`                         | expects the fork's paths and name                                                                                     |
| `apps/desktop/src/app/DesktopUserData.test.ts`                            | expects the fork's profile directory                                                                                  |
| `scripts/build-desktop-artifact.ts`                                       | bundle id and nightly product name from `FORK_IDENTITY`                                                               |
| `scripts/build-desktop-artifact.test.ts`                                  | expects the fork's bundle id                                                                                          |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts`                         | expects the fork's profile and name                                                                                   |
| `apps/desktop/src/app/DesktopClerk.test.ts`                               | expects the fork's profile directory                                                                                  |
| `packages/shared/package.json`                                            | one-shot: `./forkOneShot` subpath export                                                                              |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`            | one-shot: prepends the hidden instruction to the provider text; device-sender: carried upstream #20112, drop on merge |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts`       | slash-context: a side-chat slash command stays at the prompt start                                                    |
| `apps/server/src/server.ts`                                               | one-shot: starts `ForkOneShotSettleReactor`                                                                           |
| `packages/contracts/src/orchestratorMcp.ts`                               | one-shot: `settleWhenDone` on `create_threads` entries                                                                |
| `apps/server/src/mcp/OrchestratorMcpService.ts`                           | one-shot: `create_threads` attaches the record                                                                        |
| `apps/server/src/mcp/toolkits/project/tools.ts`                           | one-shot: `settleWhenDone` on `t3_thread_launch`                                                                      |
| `apps/server/src/mcp/toolkits/project/handlers.ts`                        | one-shot: `t3_thread_launch` attaches the record                                                                      |
| `apps/web/src/components/chat/ComposerControlsBar.tsx`                    | one-shot: renders the draft toggle as the first resting block                                                         |
| `apps/web/src/components/chat/useComposerSend.ts`                         | one-shot: send path adds the record to a first message                                                                |
| `apps/server/src/auth/EnvironmentAuth.ts`                                 | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/auth/utils.ts`                                           | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/EffectWorker.ts`                        | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/Orchestrator.ts`                        | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.ts`          | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/SteeringCompletion.integration.test.ts` | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/ThreadLaunchService.ts`                 | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts`             | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/device/DeviceHubProxy.test.ts`                           | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/preview/ServerBrowserStream.test.ts`                     | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/ws.ts`                                                   | device-sender: carried upstream #20112, drop on merge                                                                 |
| `apps/server/src/ws.test.ts`                                              | device-sender: carried upstream #20112, drop on merge                                                                 |
| `packages/contracts/src/orchestrationV2.ts`                               | device-sender: carried upstream #20112, drop on merge                                                                 |
| `packages/provider-core/src/server/runtimeInstructions.test.ts`           | device-sender: carried #20112 `withUserDevice` tests beside upstream's                                                |
| `packages/provider-core/src/server/runtimeInstructions.ts`                | device-sender: carried upstream #20112, drop on merge                                                                 |
| `packages/contracts/src/git.ts`                                           | git-paths: keeps leading and trailing spaces in file paths (268aa41971)                                               |
| `packages/contracts/src/git.test.ts`                                      | git-paths: expects whitespace-preserving paths                                                                        |
| `apps/web/src/components/auth/PairingRouteSurface.tsx`                    | pairing-hash: submits a pairing token that arrives by hashchange (dada3d110b)                                         |
| `packages/client-runtime/src/state/threadSettled.ts`                      | someday-snooze: adds the Later preset, its wake label, and the shelf split export                                     |
| `packages/client-runtime/src/state/threadSnoozed.test.ts`                 | someday-snooze: upstream preset cases filter out the Later preset                                                     |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`                 | someday-snooze: "Saved for later" instead of a countdown                                                              |
| `apps/web/src/components/chat/useThreadLifecycle.tsx`                     | someday-snooze: thread status line reads "Saved for later" instead of a countdown                                     |
| `apps/web/src/components/Sidebar.tsx`                                     | later-shelf: splits Later threads out of Snoozed, renders their shelf, and adds Later to the bulk menu                |
| `apps/web/src/components/Sidebar.logic.ts`                                | later-shelf: `later-header` marker, a snoozed slot that takes no drops                                                |
| `apps/web/src/components/Sidebar.drag.ts`                                 | later-shelf: shelf header list and drag projection hook                                                               |
| `apps/web/src/components/sidebar/SidebarListMarkers.tsx`                  | later-shelf: header accepts the `later-header` marker                                                                 |
| `apps/mobile/src/features/threads/threadListV2.ts`                        | later-shelf: `v2-later-shelf` list item type and equality                                                             |
| `apps/mobile/src/features/threads/useThreadListV2.ts`                     | later-shelf: builds every snoozed row, then splits and collapses both shelves                                         |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx`               | later-shelf: exports the shelf header, adds its Later label, and puts Later beside Snooze in the long-press menu      |
| `apps/mobile/src/features/home/HomeScreen.tsx`                            | later-shelf: renders the Later shelf header                                                                           |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`            | later-shelf: renders the Later shelf header                                                                           |
| `apps/web/src/components/threadActionMenu.logic.test.ts`                  | later-shelf: expects Later disabled without permission                                                                |
| `apps/web/src/components/threadActionMenu.logic.ts`                       | later-shelf: Later sits right after Snooze in the thread menu                                                         |
| `apps/server/src/mcp/toolkits/thread/tools.ts`                            | strict-thread-target: unknown keys must not retarget a caller-default write                                           |
| `apps/server/src/mcp/toolkits/core.test.ts`                               | strict-thread-target: merge, cancel, and model change with `threadIds` stay off the caller                            |
| `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                      | strict-thread-target: `t3_thread_update` rejects an unknown thread key                                                |
| `apps/server/src/mcp/toolkits/attachment/tools.ts`                        | strict-thread-target: `t3_thread_send_attachments` rejects an unknown thread key                                      |
| `apps/server/src/mcp/toolkits/pullRequests/tools.ts`                      | strict-thread-target: link, unlink, list, and watch reject an unknown thread key                                      |
| `apps/server/src/mcp/toolkits/worktree/tools.ts`                          | strict-thread-target: `t3_worktree_list` rejects an unknown thread key                                                |
| `apps/web/src/hooks/useScratchProject.ts`                                 | scratch-machine: a remembered machine wins over the primary environment for no-project threads                        |
| `apps/web/src/hooks/useScratchProject.test.ts`                            | scratch-machine: injects the remembered machine and covers its precedence                                             |
| `apps/web/src/components/chat/useDraftEnvironmentRouting.ts`              | scratch-machine: switching a no-project draft's machine remembers it                                                  |
| `apps/web/src/components/chat/ChatComposer.tsx`                           | questions-button: renders the `/q` button beside attach and sends it through the composer's submit path               |
| `apps/web/src/i18n/translations/`                                         | fork copy keys, generated: on conflict take upstream and rerun `vp run i18n:generate` in `apps/web`                   |
| `apps/mobile/src/i18n/translations/`                                      | fork copy keys, generated: on conflict take upstream and rerun `vp run i18n:generate` in `apps/mobile`                |
