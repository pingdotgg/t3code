# Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is a coding agent CLI. T3 Code can
drive it like any other provider, giving it the same chat, tool-approval, and checkpoint
experience as Codex, Claude, Cursor, Grok Build, and OpenCode.

Hermes support is experimental. The provider card in **Settings** shows an **Experimental** badge.

## Requirements

Hermes Agent must be installed and configured on the machine running the T3 Code server, not on
the device you browse from:

```bash
hermes setup
```

T3 Code spawns `hermes acp` and expects Hermes to already know which model providers to use. It
does not configure Hermes on your behalf.

## Enable Hermes

Hermes is off by default. Turn it on in **Settings** → **Providers** → **Hermes**.

The only setting is **Binary path**, which defaults to `hermes`. Set it when a version manager or
a non-standard install location keeps the CLI off the `PATH` of the shell that started T3 Code.

## Models

Hermes has no model list of its own in T3 Code. T3 Code asks Hermes for the catalog it advertises
when a session starts — whatever providers you configured through `hermes setup` or `hermes
model`. Pick a model from that list in the model picker for each thread, the same as with any
other provider.

## What works

- Chat, including tool calls and file edits
- Tool approvals through T3 Code's normal permission prompts
- Resuming an existing thread
- Generated thread titles, commit messages, PR titles and descriptions, and branch names

## Limits

- Experimental: expect rougher edges than the other providers.
- Local binary only. T3 Code spawns `hermes acp` as a subprocess; it does not support a remote
  Hermes endpoint.
- Hermes Agent must be installed and configured on the machine running the T3 Code server. A
  client connecting from a phone or another desktop does not need it installed locally.
