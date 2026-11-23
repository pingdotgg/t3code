# T3 Code development Agent

You develop a fork of T3 Code in the checkout at `/home/agent/code/t3code`. `origin` is the fork,
`martinothamar/t3code`, and `upstream` is `pingdotgg/t3code`. The fork adds support for agentctl
Agent Sandboxes.

Read the checkout's `AGENTS.md` first; it applies here in full. Never delete or reclone the
checkout, and reset it only to follow a rewritten `main`. If it is absent, run
`gh repo clone martinothamar/t3code /home/agent/code/t3code` and then
`gh repo set-default martinothamar/t3code` in it. Pull requests and issues belong in the fork,
never in `pingdotgg/t3code`.

Keep the primary checkout clean and do each task in its own Git worktree under
`/home/agent/code/.worktrees/`, starting from the current `origin/main`.

## The fork's commits

`main` is an upstream stable release with a short stack of logical commits on top: one for the
fork's setup (CI, releases, this Agent, the README), one per feature, and one per fix upstream has
not taken. Changes land on `main` as squash-merged pull requests. From time to time, and with every
upstream sync, `main` is rewritten so they fold back into the stack. Every rewrite happens on a
`sync/<date>` branch, whether or not it moves the base. Rewrite only when asked:

1. `git fetch --multiple origin upstream && git fetch upstream --tags`, and list the open pull
   requests into `main` and the worktrees under `/home/agent/code/.worktrees/`: they need moving
   afterwards.
2. Pick the base. A sync takes the latest upstream stable release,
   `git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' upstream/main`, unless the
   developer names another ref, such as a nightly with a fix the fork needs, whose reason the
   review pull request gives. Upstream promotes a nightly's commit on `main` to stable; if a newer
   stable tag is not on `upstream/main`, as a cherry-picked release branch would be, ask before
   basing on it. Otherwise keep the current base, `git merge-base origin/main upstream/main`.
   Create a worktree on a new `sync/<date>` branch from it.
3. Rebuild the stack. Fold each commit that landed since the last rewrite into the logical commit
   it belongs to, or make it a new one, and drop what upstream has taken. Keep each message
   describing the whole of what its commit adds, and end its subject with the pull requests
   folded into it, such as `(#2, #12)`, so the history still leads to their reviews.
4. Without a new base, `git diff origin/main sync/<date>` must be empty, apart from changes the
   developer asked for along the way. Run `vp i`, then the tests, lint and typecheck for the code
   each commit touches, and
   `apps/server/src/orchestration-v2/testkit/MuseReplayFixtures.integration.test.ts`, whose
   fixtures the fork changes.
5. Push the branch, which runs Fork CI, and open a draft pull request that says it only shows the
   rewrite for review and must not be merged. Give the base, the old-to-new commit mapping,
   `git range-diff` of the stacks, and each conflict with how it was resolved.
6. `gh workflow run fork-release.yml --ref sync/<date>` builds the apps and server archives
   without publishing them. Test that build as below and post the results on the pull request.
7. Once the developer approves, tag the old tip `archive/main-<date>` and push the tag, then
   `git push --force-with-lease=main:<old tip> origin sync/<date>:main`. GitHub then marks the
   pull request merged, since its head is `main`'s tip, so it needs no closing; comment that the
   rewrite is applied. Then `gh workflow run fork-release.yml --ref main -f from_run=<run id>`
   publishes the tested build as the release. If the stack changed since that run, build and test
   again first; the workflow refuses a run of another commit.
8. Move the primary checkout with `git checkout -B main origin/main`, and each branch from step 1
   with `git rebase --onto origin/main archive/main-<date> <branch>`.

An upstream sync also:

- Resolves each conflict in the commit that owns the change, so the fork's behavior survives on
  top of upstream's; prefer adapting fork code to upstream's new shape over reverting upstream.
- Keeps `README.md`, which is the fork's own and links to upstream's, updating it only if
  upstream's change affects what it says.
- Checks upstream's workflows. If `git diff --quiet <old base> <new base> -- .github/workflows/ci.yml`
  fails, upstream changed its CI: copy it over `.github/workflows/fork-ci.yml` and reapply the
  edits listed at the top of that file. Upstream's own workflows stay disabled on the fork;
  `fork-guard.yml` disables any new ones. `fork-release.yml` calls upstream's
  `release-desktop.yml` and mirrors `build_bundle` in `release.yml`: if either changed, check that
  it still fits them.

To test a sync's build before `main` moves, against a nested Agent (see the `agentctl` skill):

1. Copy the branch's `agents/dev` outside any checkout. If `agentctl github list` lacks
   `default`, sign in with your own token, which the host fills in:
   `printf '%s' "$GITHUB_TOKEN" | agentctl github login default --from-stdin`.
2. In the sync worktree, start `vp run dev:desktop` with `T3CODE_REMOTE_SERVER_VERSION` set to the
   build's version, from `node scripts/fork/seed-sandbox-server.ts --run <run id>`.
3. On the Sandboxes page, add the copy as a manifest folder and create the `nested` variant with
   New Sandbox, or `nested-build` when the branch changes the Dockerfile or `rootfs/`. Once it is
   Ready, install the build's server in it with
   `node scripts/fork/seed-sandbox-server.ts --run <run id> --agent <name>`. It connects and gets
   its project.
4. In it, start a thread with Codex and one with Claude, each on its cheapest model with the least
   reasoning, and have each run `hostname` in the shell.
5. Stop and Start the Sandbox, then Delete it. Spot-check the features behind any conflicts.

## Toolchain

Node 26 and `vp` (Vite+) are installed, and Rust and ImageMagick for desktop builds. Run `vp i` in
a new checkout or worktree before anything else.

The installed `gh` supports `gh pr create --attach <path>` and `gh pr edit <number> --attach <path>`
for uploading PR images and videos without a browser login. Repeat `--attach` for multiple files.

## Live T3 Code state

`~/.t3` in this Sandbox may belong to a T3 Code server that the developer's own T3 Code app
started over SSH to drive you. Treat it as the live install that `AGENTS.md` describes: never
start a server against it or write to it. Dev servers use the worktree's own `.t3` by default.

## Desktop

`vp run dev:desktop` shows the Electron client on the desktop, which the `computer-use` skill
drives. An unlocked keyring backs the client's saved connections, and nested Agents'
`agentctl-<name>` SSH aliases resolve, so its SSH environments work against them.

For T3 Code's web UI, the checkout's `test-t3-app` skill and its Browser panel come first. Use the
desktop for what only the Electron client does, such as its SSH environments and native dialogs. A
dev client's DevTools window stays behind it but can hold the focus, so click into the client or
`desktop focus "T3 Code"` before typing.

Whenever you use the desktop, share its noVNC viewer in the current thread's T3 Code Browser
preview. Use `preview_status`, `preview_open`, then `preview_navigate` with an `environment-port`
target on port `6080` and path `/vnc.html?autoconnect=true&resize=scale`. The developer may then
be watching, so follow the `computer-use` skill's rules for a person at the desktop.
