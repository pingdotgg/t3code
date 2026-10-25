# T3 Code for agentctl Sandboxes

A fork of [T3 Code](https://github.com/pingdotgg/t3code) that runs agents in
[agentctl](https://github.com/digdir/digdir-agents) Sandboxes. It follows upstream's stable
releases; for what T3 Code is and how to use it, see
[upstream's README](https://github.com/pingdotgg/t3code#readme).

## Getting started

You need Git and [Node 26](https://nodejs.org). Clone the repository:

```sh
git clone https://github.com/martinothamar/t3code.git
cd t3code
```

Then install the desktop app, either the latest release:

```sh
node scripts/fork/install-desktop.ts
```

or a build of the checked-out commit, which also needs [`vp`](https://viteplus.dev/guide/), Rust
from [rustup](https://rustup.rs) and your platform's
[build tools](./docs/operations/development.md#linux-appimage-prerequisites):

```sh
node scripts/fork/install-desktop.ts --from-source
```

With Make installed, `make install` and `make install-source` run the same commands; `make` lists
the shortcuts. In PowerShell, `.\make-install.ps1` and `.\make-install.ps1 -FromSource` do. Where
PowerShell's execution policy blocks scripts, run one as
`powershell -ExecutionPolicy Bypass -File .\make-install.ps1`.
[Installing](./docs/operations/fork-desktop-build.md) has the details.

To connect to Sandboxes, run `agentctl ssh-config install` once, and give your Agents
`access: [{type: ssh}]` in their manifests. They then show up in the app; see
[agentctl Sandboxes](./docs/user/agentctl-sandboxes.md).

## Updating

We force-push `main` when updating the fork, so update your checkout with a fetch and hard reset
instead of `git pull`.

```sh
git switch main
git fetch origin
git reset --hard origin/main

# Or
make pull
```

In PowerShell, `.\make-pull.ps1` does the same.

## Developing the fork

[`agents/dev`](./agents/dev) is an agentctl Agent for working on this fork. Start at
[AGENTS.md](./AGENTS.md). Pull requests and issues go to this repository, not upstream.
