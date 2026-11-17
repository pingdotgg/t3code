# T3 Dulli

T3 Dulli is the community fork of [T3 Code](https://github.com/pingdotgg/t3code), rebuilt on **stable v0.1.10**. It is an open-source desktop, web, and mobile control surface for coding agents, using your existing provider subscriptions.

The fork keeps upstream's native providers, subagents, schedules, and usage features. Claude, Muse, Codex, and upstream Pi are supported by T3's own integrations. The retired Dulli provider and its Pi-extension bridges are not included.

## Install

Download desktop installers and the Android APK from [T3 Dulli releases](https://github.com/YJJosh/t3dulli/releases). Fork releases use versions such as `0.1.10-dulli.1` and are marked as prereleases on GitHub.

For the CLI:

```sh
npm install -g @yjosh/t3
t3
```

Or try a published release with `npx @yjosh/t3@latest`. The launcher downloads and verifies the matching native release archive. CLI archives support macOS Apple Silicon, Linux x64/arm64 (glibc), and Windows x64/arm64. Desktop downloads also include Intel macOS builds.

T3 Dulli can live beside upstream T3 Code: it uses its own app ID, icons, update feed, and `~/.t3-dulli` home. Existing fork userdata stays in that home. Both CLIs use the command `t3`, so choose which installation owns it on your PATH. Do not point it at upstream's live data directory.

Community macOS releases have a persistent self-signed signature, but no Apple notarization. After copying to Applications, the first launch may require **System Settings → Privacy & Security → Open Anyway**. Windows installers can trigger SmartScreen. Android APKs require sideloading and update by installing a newer APK, not through upstream's store/OTA channels. Only approve downloads you trust.

Install and authenticate your provider on the machine hosting T3 Dulli. Remote clients connect to that host; they do not need their own copies of the provider CLIs. See [user guides and provider setup](docs/user/) for upstream's supported integrations and connection modes.

## Development

See [fork development](docs/fork-development.md) for identity, native builds, signing, releases, Portler, and fork migrations. [AGENTS.md](AGENTS.md) contains contributor conventions; the [upstream development guide](docs/operations/development.md) covers the toolchain.

```sh
vp i
vp run dev
```

Dev state lives in the worktree's `.t3`. Never run a development server against `~/.t3/userdata` or `~/.t3-dulli/userdata`; use read-only copies into the sandbox instead.

Fork feature work covers Workler workspaces and multi-repo projects, agent-controlled thread terminals, per-vault 1Password access, and profiles from a git-synced prompts/skills folder. T3 itself is the harness; no Pi session or judge replacement is planned.

## Upstream and license

T3 Dulli is an independent community build, not an official T3 Tools release. Thanks to the upstream T3 Code maintainers and contributors. The project remains [MIT-licensed](LICENSE); bundled third-party notices ship with the applications.
