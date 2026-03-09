# Fork details

This is a personal fork. It contains features I need for testing. All features are experimental, and I do not consider them fully done yet.

## Changes

- `feat/nix-flake-support`: Adds Nix flake packaging/build setup for this fork.
- `feat/nix-flake-devshell-integration`: Adds Nix flake dev shell integration and the runtime toggle.
- `feat/ctrl-enter-send`: Adds configurable Ctrl+Enter-to-send behavior in the chat composer.
- `fix/session-resume`: Reuses persisted provider resume cursor when live runtime session is missing.

Stack of all changes is on `stack/all`.

# T3 Code

T3 Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for T3 Code to work.

```bash
npx t3
```

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/pingdotgg/t3code/releases)

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
