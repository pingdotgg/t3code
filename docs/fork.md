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
  upstream-owned files stay minimal and every edited file has a primary owner
  in [the feature map](fork-features.md) and an entry in the machine-checked
  allowlist `scripts/fork-upstream-edits.txt` (one path per line).
- **Remotes.** `origin` is `toolboxmd/t3code`; `upstream` is
  `pingdotgg/t3code`. Never push to `upstream`, never send fork commits there
  (offering extension points upstream is a separate human decision, out of
  scope for routine maintenance).

## Feature inventory and upstream edits

[The feature map](fork-features.md) lists every fork feature, its Issue and PR,
new files, edited upstream files, shared files and watch keywords. It is the
canonical inventory used by the checks and the overlap report. Each path in
`scripts/fork-upstream-edits.txt` has exactly one primary feature owner in the
map, including historical entries for fork-new files. Shared edits are recorded
under the other features so the report considers every affected capability.

When adding or removing a feature, update the map and allowlist in the same PR.
`scripts/fork-check.sh` rejects unallowlisted upstream edits, unmapped allowlist
entries, duplicate owners and malformed feature metadata.

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
stack onto `upstream/main` after printing an overlap report, runs the fork check, optionally runs the full
proof, and optionally pushes. It reports conflicts per upstream file and never
force-pushes a published branch without proof passing in the same run.

Before any rebase, the routine scans every upstream commit from the current
merge base (the last absorbed upstream commit) to the fetched target. It groups
matches by feature, using exact touched paths and case-insensitive literal watch
keywords in commit titles, touched paths and diffs. Shared paths are matched for
each feature that uses them. Merge commits are compared with their first parent.
The report includes full base, target and matching commit SHAs, match reasons and
a decision placeholder for each feature/commit pair.

Run `scripts/fork-rebase.sh --dry-run` first and retain its output in the
absorption PR, before absorbing. For every match record one decision with a
rationale: **keep ours**, **adopt upstream and delete ours**, or **merge both**.
For adoption, name the fork paths removed; for a merge, describe the single
combined behavior and its proof. Review the report even when Git finds no
conflicts. No matches does not establish that no semantic overlap exists.
Do not approve or land an absorption PR with pending decisions. After conflict
resolution, retain the original report: recomputing from the new merge base
would omit the just-absorbed commits. A report can also be reproduced without
fetching or rebasing using `node scripts/fork-features.mjs report <base> <target>`.

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
- every modification to an upstream-owned file is allowlisted in
  `scripts/fork-upstream-edits.txt` (new fork-only files are always fine),
- this document and a valid feature map exist, with exactly one feature owner
  for every allowlisted upstream edit.

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
