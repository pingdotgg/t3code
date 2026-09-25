# Fork maintenance

This repo (`toolboxmd/t3code`) is a thin, rebasable layer on upstream
`pingdotgg/t3code`. Upstream `main` is the base; fork work is a small stack of
topic commits kept on top of it. This document describes the model, the
maintenance routine, and the upstream extension points that would shrink the
patch set further.

## Model

- **Base.** Upstream `main` (`https://github.com/pingdotgg/t3code.git`,
  remote name `upstream`). Fork `main` is that base plus the stack below.
- **Stack.** Fork work lives as topic commits on top of the current upstream
  base. A topic PR is squash-merged, so each lands as one stack commit. No
  merge commits: upstream updates are absorbed by rebasing the stack, never
  by merging `upstream/main` into the fork.
- **Absorption moves `main`.** Rebasing the stack rewrites `main`, which no
  PR merge can do: squash or rebase merges would copy upstream commits under
  new hashes and break the stack. An absorption is proven on its own branch
  and then lands with `--force-with-lease` (see Routine). That push is a
  human-approved step.
- **New files first.** Features go in new files and new packages. Edits to
  upstream-owned files stay minimal and every edited file is listed under
  "Upstream edits" below and in the machine-checked allowlist
  `scripts/fork-upstream-edits.txt` (one path per line).
- **Remotes.** `origin` is `toolboxmd/t3code`; `upstream` is
  `pingdotgg/t3code`. Never push to `upstream`, never send fork commits there
  (offering extension points upstream is a separate human decision, out of
  scope for routine maintenance).

## Fork-only content

New files owned by the fork (no upstream counterpart, always allowed):

- `VISION.md`, `MISSION.md`, `OBJECTIVE.md`, `GLOSSARY.md`: Project Direction
  and project language.
- `assets/chromeria/`, `apps/web/public/chromeria-mark.png`: Chromeria icons.
- `docs/fork.md`: this document.
- `scripts/fork-rebase.sh`: the rebase routine.
- `scripts/fork-check.sh`: the stack-model check run by CI.
- `scripts/fork-maintenance.test.ts`: tests driving both scripts against
  throwaway git fixtures (runs with upstream's own test suite).
- `scripts/fork-upstream-edits.txt`: allowlist of upstream files the fork
  may modify.
- `.github/workflows/fork.yml`: fork CI (the stack check).

## Upstream edits

Upstream-owned files modified by the fork. `scripts/fork-check.sh` fails on
any modified upstream file missing from `scripts/fork-upstream-edits.txt`.

- Chromeria branding (#12, #13): `apps/desktop/package.json` (product
  name), `apps/desktop/src/app/DesktopEnvironment.ts` (names, userData
  directory), `scripts/build-desktop-artifact.ts` (app id, artifact name, no
  update feed, icons), `scripts/lib/brand-assets.ts` (icon paths), and the
  expectations in `apps/desktop/src/app/DesktopAppIdentity.test.ts`,
  `apps/desktop/src/app/DesktopPreReadyPlatform.test.ts`,
  `scripts/build-desktop-artifact.test.ts` and
  `scripts/lib/brand-assets.test.ts`.
- Chromeria name in the web UI (#14): `apps/web/index.html`,
  `apps/web/src/branding.ts`, `apps/web/src/lib/bootError.ts`, and the
  branding fixture in `apps/web/src/bundledDev.test.ts`, plus the
  components `T3Wordmark.tsx`, `chat/MessagesTimeline.tsx`,
  `onboarding/WelcomeWizard.tsx`, `settings/IntegrationsSettings.tsx`,
  `settings/ThemePreviewCircles.tsx` and `sidebar/SidebarChrome.tsx` under
  `apps/web/src/components/`, with expectations in
  `apps/web/src/bootstrap.test.ts` and `apps/web/src/branding.test.ts`.
- Child threads and project-scoped supervision (#8, #10, #15):
  `apps/server/src/mcp/McpHttpServer.ts` registers the threads MCP toolkit;
  `apps/server/src/mcp/toolkits/threads/childThreads.test.ts`, `handlers.ts`
  and `tools.ts` implement and test child and same-project listing, reading and
  messaging; `apps/web/src/components/AgentsPanel.tsx` links agents to their
  child threads; `apps/web/src/components/Sidebar.tsx` and
  `apps/web/src/components/LegacySidebar.tsx` hide child threads from the
  sidebar.
- Agents panel sections, child tree and breadcrumb (#17):
  `apps/web/src/components/AgentsPanel.tsx` splits Prism spawns from direct
  spawns and nests child threads under their row;
  `apps/web/src/components/chat/ChatHeader.tsx` renders the parent crumb and
  sibling menu for a child thread. The logic lives in the fork-owned
  `AgentThreadTree.logic.ts`, `AgentThreadTree.tsx` and `chat/ThreadParentCrumbs.tsx`.
- `scripts/build-desktop-artifact.ts` (#10): the packaged-bundle
  self-containment probe clears an inherited `ELECTRON_RUN_AS_NODE`.
- `apps/server/src/entrypoint.test.ts` (#10): resolves the fixture directory
  so the test passes under macOS's symlinked `TMPDIR`.
- `.github/workflows/ci.yml`, `.github/workflows/mobile-fingerprint-check.yml`:
  `blacksmith-*-ubuntu-2404` runners become `ubuntu-24.04` and
  `blacksmith-*-macos-*` becomes `macos-15` (see CI).

## Chromeria desktop app

Chromeria is the fork's desktop build: bundle id `md.toolbox.chromeria`,
Electron userData `~/Library/Application Support/chromeria`, no update feed.
It installs next to upstream "T3 Code (Alpha)" and reads the same T3 home
(`T3CODE_HOME`, else `~/.t3`, state in `<home>/userdata`), so its threads
are the upstream app's threads.

**Never run Chromeria and T3 Code (Alpha) on the same T3 home at once.** Both
would start a server on one database. Quit one fully (Cmd-Q, not just close
the window) before opening the other. To try Chromeria while the upstream
app keeps running, give Chromeria its own home, which starts with no threads:

```bash
open -na /Applications/Chromeria.app --env T3CODE_HOME="$HOME/.t3-chromeria"
```

Build (Apple Silicon, from a checkout of fork `main`):

```bash
pnpm install --frozen-lockfile
pnpm dist:desktop:dmg:arm64      # writes release/Chromeria-<version>-arm64.dmg
```

Install or update (quit Chromeria first):

```bash
hdiutil attach release/Chromeria-*-arm64.dmg -nobrowse -mountpoint /tmp/chromeria-dmg
rm -rf /Applications/Chromeria.app
ditto /tmp/chromeria-dmg/Chromeria.app /Applications/Chromeria.app
hdiutil detach /tmp/chromeria-dmg
codesign --force --deep --sign - /Applications/Chromeria.app
open /Applications/Chromeria.app
```

Gotchas:

- The local build is unsigned. Without the ad-hoc `codesign` step macOS
  reports the app as damaged or refuses to open it.
- Each build has a new ad-hoc signature, so macOS may ask again for
  permissions granted to the previous build (screen recording, folders).
- There is no auto-update. Updating is: pull fork `main`, rebuild,
  reinstall as above.
- Both apps register the `t3code://` URL scheme, so a browser sign-in
  callback may open either app.
- Both apps prefer backend port 3773; whichever starts second takes the next
  free port.

## Routine

`scripts/fork-rebase.sh` fetches `upstream`, rebases the current branch's
stack onto `upstream/main`, runs the fork check, optionally runs the full
proof, and optionally pushes. It reports conflicts per upstream file and never
force-pushes a published branch without proof passing in the same run.

The proof runs in a host-neutral environment, because upstream's tests assume
CI's Linux host. On a Mac, run from a T3 thread, about 50 upstream tests
otherwise fail without any fork change: T3 Code desktop leaks
`ELECTRON_RUN_AS_NODE=1` into agent shells, macOS `TMPDIR` sits behind the
`/var` to `/private/var` symlink, and Homebrew's `brew` on `PATH` adds
provider probes. To run the proof by hand:

```bash
env -u ELECTRON_RUN_AS_NODE TMPDIR="$(cd "$TMPDIR" && pwd -P)/" \
  PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/opt/homebrew' | paste -sd: -)" \
  sh -c 'pnpm install --frozen-lockfile && pnpm exec vp run -r typecheck && pnpm exec vp lint && pnpm exec vp run -r test && pnpm exec vp fmt --check'
```

```bash
# Report the stack and what an absorption would replay, without changing anything.
scripts/fork-rebase.sh --dry-run

# Absorb upstream updates (fetch + rebase + fork check).
scripts/fork-rebase.sh

# Absorb and run the full fork proof (required before pushing a rebased stack).
scripts/fork-rebase.sh --proof

# Absorb, prove, and publish (refuses unless --proof passed in the same run;
# uses --force-with-lease, never --force; refuses on main).
scripts/fork-rebase.sh --proof --push
```

An absorption, end to end:

```bash
git fetch origin
git switch -c fork/absorb-<upstream-short-sha> origin/main
scripts/fork-rebase.sh --proof --push
# Publish the new upstream base and open the PR against it, not against main:
git push origin <upstream-sha>:refs/heads/absorb-base/<upstream-short-sha>
gh pr create --base absorb-base/<upstream-short-sha> --head fork/absorb-<upstream-short-sha>
# Do not merge it through GitHub. After approval, land the proven branch on main:
git push --force-with-lease=main:<old-origin-main-sha> origin fork/absorb-<upstream-short-sha>:main
```

A PR from an absorption branch to `main` conflicts with it, and GitHub runs no
`pull_request` workflows for a conflicting PR. Based on the upstream commit,
the PR shows only the fork stack and CI runs. The Fork Stack Model job is
unaffected: `fork-check.sh` finds its base from `upstream/main`, not the PR
base. Delete the `absorb-base/*` branch after landing.

The absorption PR's description is the absorption record, with a copy on the
fork-maintenance Issue: exact base and candidate commits, conflicts per
upstream file with their resolution, the overlap decisions, elapsed time and
proof. It is not kept in this repository.

Open topic PRs then rebase onto the new `main` (`git rebase --onto
origin/main <old-origin-main-sha>`).

On conflict the script stops at the failing commit, prints the conflicted
upstream files (`git diff --name-only --diff-filter=U`), and exits non-zero
with the rebase left in progress for manual resolution (`git status` to see
the files, resolve, `git rebase --continue`, then re-run the script). Record
the conflicted files and their resolution in the absorption record.

Rules:

- Never `git push --force`. A published rebased branch moves only via
  `git push --force-with-lease` after the same proof passed.
- `main` moves only by squash-merging a topic PR, or by the approved
  `--force-with-lease` landing of a proven absorption branch.
- Bind proof to the final candidate: any rebase or conflict resolution
  invalidates earlier proof, so the proof must run last.

## CI

Upstream's jobs run on Blacksmith runners the fork does not have, so they
would queue forever. The fork remaps the PR and `main` workflows (`ci.yml`,
`mobile-fingerprint-check.yml`) to GitHub-hosted runners, which are free for
public repositories. Release, deploy, preview and Windows workflows keep
their Blacksmith labels: they need upstream secrets and must not run here.

`.github/workflows/fork.yml` runs on every pull request and on pushes to
`main`, alongside `ci.yml`. It adds the `upstream` remote, fetches it, and
runs `scripts/fork-check.sh`, which verifies:

- the stack on top of the upstream base contains no merge commits,
- the stack is small (at most 20 commits),
- every modification to an upstream-owned file is allowlisted in
  `scripts/fork-upstream-edits.txt` (new fork-only files are always fine),
- this document exists.

## Candidate upstream extension points

Generic seams the fork's planned work (Model Router threads, OpenBot mode)
will need. Each is written so that, if upstream ever adopted it, the stated
fork patch would disappear. Offering any of them upstream is a human decision
and explicitly out of scope for this maintenance work; this list only records
what each would remove.

- **`parentThreadId` on `thread.create`.** `ThreadCreateCommand`
  (`packages/contracts/src/orchestration.ts`) and `ThreadCreatedPayload` carry
  no parent link, so Model Router job threads would need a fork patch that
  smuggles the parent linkage (via title prefix, metadata, or a parallel
  fork-owned map). A real optional `parentThreadId` field would remove that
  patch entirely.
- **Thread visibility independent of archive state.** Threads are listed or
  hidden by existing lifecycle flags; there is no "hidden from the sidebar
  but reachable from the Agents panel" concept, so Model Router job threads
  would need a fork patch in the sidebar query plus the Agents panel
  (`apps/web/src/components/AgentsPanel.tsx`). A first-class visibility flag
  would remove both edits.
- **Right-panel tab registry.** `RightPanelSurface`
  (`apps/web/src/rightPanelStore.ts`) is a closed union and
  `apps/web/src/components/RightPanelTabs.tsx` renders a fixed tab set, so an
  OpenBot Computer tab would require editing both upstream files. A registry
  (fork registers a tab kind without touching the union or renderer) would
  remove those edits.
- **Thread persona/owner marker.** `ThreadCreatedPayload` carries no agent
  identity, so a Bot-as-thread-with-persona would need a fork patch to attach
  and render it. An optional upstream persona field would remove that patch.
