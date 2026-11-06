---
title: "Build T3 Code from source"
description: "Build T3 Code with the documented vp setup, run web or desktop development, keep data separate, and prepare local desktop artifacts."
updated: 2026-11-04
sources:
  - label: "Development setup, checks, and desktop prerequisites"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/operations/development.md"
  - label: "Vite+ installation and provider requirements"
    url: "https://github.com/pingdotgg/t3code/blob/main/README.md"
  - label: "Scripts and pinned Node version"
    url: "https://github.com/pingdotgg/t3code/blob/main/package.json"
  - label: "Development data and origin constraints"
    url: "https://github.com/pingdotgg/t3code/blob/main/AGENTS.md"
faq:
  - question: "How do I build T3 Code from source?"
    answer: "Install Vite+'s vp command and obtain the T3 Code repository. Run vp i from its root, then vp run dev, and open the pairing URL printed by the runner."
  - question: "Which Node version does T3 Code need?"
    answer: "T3 Code's root package.json pins Node 26.12.1. Vite+ supplies the pinned Node version, so the development runbook does not require a separate Node installation."
  - question: "How do I run T3 Code desktop development?"
    answer: "T3 Code uses vp run dev:desktop for its Electron client. Native desktop prerequisites depend on the operating system and are listed in the development runbook."
  - question: "Will a T3 Code development build use my installed app's database?"
    answer: "T3 Code worktrees default to their own .t3/userdata, while the main checkout defaults to ~/.t3/dev. A worktree's first start can seed from a read-only copy of the installed app's database; never point development at the live ~/.t3/userdata."
---

T3 Code's source setup uses Vite+ through the `vp` command. Install `vp`, run `vp i` from the repository root, then run `vp run dev` and open the pairing URL it prints.

## Should you build or download T3 Code?

Use a source checkout when you want to change code, reproduce a defect, or inspect a development build. If your goal is to run the released application, use [the official download page](/download). The [Linux installation guide](/learn/start/install-linux) covers released packages for that platform.

The repository is [MIT licensed](/learn/open-source/mit-license). Before preparing an upstream patch, check [the contribution requirements](/learn/open-source/contributing). A source build does not establish approval for a product change.

## Install vp and the repository dependencies

Follow these steps in order:

1. Obtain a local checkout of the [official T3 Code repository](https://github.com/pingdotgg/t3code).
2. Install the global `vp` command using the command for your operating system below.
3. Open a terminal in the repository root, where the root `package.json` lives.
4. Install dependencies with `vp i`.

On macOS or Linux, the README gives this Vite+ installer:

```sh
curl -fsSL https://vite.plus | bash
```

On Windows, run the PowerShell installer:

```powershell
irm https://vite.plus/ps1 | iex
```

Then install the repository's dependencies:

```sh
vp i
```

Vite+ supplies the Node version pinned by the project. The current root `package.json` specifies Node `26.12.1`. You do not need to select a separate Node version before following this setup.

## Start the client you want to develop

The development runbook provides these entry points:

| You want to run                | Command              |
| ------------------------------ | -------------------- |
| Server and web client together | `vp run dev`         |
| Electron desktop development   | `vp run dev:desktop` |
| Server process separately      | `vp run dev:server`  |
| Web process separately         | `vp run dev:web`     |

Start with the combined web command unless you need another surface:

```sh
vp run dev
```

Open the complete pairing URL printed by the runner. Opening the bare origin does not authenticate a new browser. Read the selected ports from `[dev-runner]` output, since occupied ports can change the runner's choices.

Flags go after the task name. Add `--browser` when you want the runner to open a browser. Mobile development has a separate setup in `apps/mobile/README.md`.

The ordinary `dev` command also registers `Replay (dev)`. It replays recorded ACP transcripts through the real adapter, orchestration, and UI without a paid model. Bundled servers, including desktop development, skip that replay provider. For real agent work, install and authenticate the provider you intend to use.

## Keep development state separate from your installed app

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set. The main checkout defaults to `~/.t3/dev`. An explicit `--home-dir` takes precedence over either default.

On a worktree's first start, the runner can seed an empty database from a read-only copy of `~/.t3/userdata/statev2.sqlite`. The automatic copy applies when the source is at most 500 MiB. Larger sources produce a warning and development starts with an empty database.

Use `--no-seed` or `T3CODE_DEV_SEED=0` to skip that copy. Never run a development server against the live `~/.t3/userdata`. Read [the architecture guide](/learn/open-source/architecture) if you need to understand which environment owns the resulting state.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Development uses the browser's origin and Vite proxies the backend. Hard-coding localhost can break access from another machine.

## Build a local desktop artifact

Local artifact builds are unsigned by default and write into `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

Choose the command for your target and read its prerequisites first. Linux AppImage builds need Linux, Rust, C/C++ tools, libsecret headers, pkg-config, and ImageMagick. macOS DMGs need Xcode Command Line Tools and Rust. Windows installers need Rust, Python 3, and Visual Studio Build Tools with the documented C++ components.

The [development runbook](https://github.com/pingdotgg/t3code/blob/main/docs/operations/development.md#desktop-artifacts) covers architecture targets and signing. Building an artifact does not make it a signed official release.

## Next steps

- Read [the t3.json project file guide](/learn/customize/t3-project-file) for project configuration.
- Inspect [third-party notices](/learn/open-source/third-party-licenses) when preparing a distribution.
- Review [contribution evidence requirements](/learn/open-source/contributing) before submitting changes.
- Return to the [open source overview](/learn/open-source) for related source documentation.
