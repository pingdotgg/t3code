# This fork

A personal build of [T3 Code](https://github.com/pingdotgg/t3code) that combines three things:

1. **T3 Code** itself.
2. **[MT Code](https://github.com/munimtechnologies/mtcode)**, a fork of T3 Code that adds its own features and merges T3 Code regularly.
3. **This fork's own features and fixes**, kept as a short stack of commits on top.

The app shows the name "T3 Code". Internally it's MT Code's "munim" build, so it shares MT Code's settings folder (`~/.mt`) and Windows app identity, and an existing MT Code install upgrades in place.

## How updates work

The [Fork sync and build](.github/workflows/fork-build.yml) workflow runs every four hours:

1. If MT Code published a new `munim-v*` release, it re-applies this fork's commits on top of it. When a commit conflicts, Claude Code resolves it (see [`fork/resolve-conflicts-prompt.md`](fork/resolve-conflicts-prompt.md)); if it can't, the run stops.
2. On a Windows runner it installs dependencies, runs the tests and typechecks for every file the fork's commits touch, and builds the installer.
3. It checks that each fork feature is inside the installer ([`fork/installer-markers.txt`](fork/installer-markers.txt)), then publishes a GitHub release with the installer and `latest.yml`.
4. Only then does the rebased branch replace `custom`.

The desktop app's update button reads this repository's releases, so one click installs a build that has already passed. If any step fails, nothing is published, installed copies stay where they are, and the workflow opens an issue labelled `fork-pipeline`.

Pushing a new commit to `custom` also builds and publishes a release.

## Branches and versions

- `custom` (default): the latest MT Code release plus this fork's commits.
- `custom-next`: a rebased candidate that hasn't been published yet.
- Release versions turn MT Code's `x.y.z` into `x.y.(z×100+n)`, where `n` counts rebuilds on that release. For example, MT Code 0.1.52 becomes 0.1.5200, the next rebuild 0.1.5201, and MT Code 0.1.53 becomes 0.1.5300. Each new version sorts above the last, so the updater always offers it.

## Phone app (branch `ryan/mobile-parity`)

The fork's desktop features, ported to the Android app (`apps/mobile`). It is sideloaded as a separate app named "T3 Code Fork" (the `preview` variant, package `com.t3tools.t3code.preview`), so it sits beside the official app.

- **Next-prompt buttons:** 2–4 buttons above the message box after a run. A reply's `options` block shows as buttons and is hidden from the reply. With the Labs "Suggest next prompt" switch on, the provider's prediction and the small model's picks show too. A tap fills the empty box and never sends.
- **Inline pages fill the message box:** a page's button can call `t3Compose(text)` to append to that thread's draft, only after a real tap (at most 4 requests and 20,000 characters per tap). It works inline and full screen.
- **Move to project:** a No project thread's menu can file it under an existing project.
- **New thread button:** a setting (Settings > General) that makes New thread start a No project thread without the picker.
- **Folded turns** show their step count, **titles shimmer** while they regenerate, and **Markdown frontmatter** shows as a table.
- **Read aloud:** a speaker button on replies plays Microsoft Edge's natural voices. They are made by a small service on the paired PC (port 3776 over Tailscale), not by the phone, whose own voices are poor. Pick the voice in Settings > Voice. It works only over a direct (Tailscale) connection, not a relay.

The phone app needs `crypto.getRandomValues`, which Hermes lacks; `apps/mobile/src/lib/cryptoPolyfill.ts` provides it.

## Repository secrets

- `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token`, used only to resolve merge conflicts.
- `FORK_PUSH_TOKEN`: a fine-grained token for this repository with Contents and Workflows read/write. The built-in token can't push branches whose commits change `.github/workflows`, and every MT Code release does.

All other workflows inherited from T3 Code and MT Code are switched off by the pipeline.
