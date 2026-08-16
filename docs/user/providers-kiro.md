# Kiro

Kiro support is early access. This guide covers turning it on, choosing an agent, and what works
differently from the other providers. For first-time setup, see [Install T3 Code](./install.md).

## Turn Kiro On

Kiro starts switched off, so nobody without the CLI sees a broken provider card.

1. Install [Kiro CLI](https://kiro.dev/docs/cli/) on the machine running the T3 Code server.
2. Log in on that same machine:

   ```bash
   kiro-cli login
   ```

3. In T3 Code, open Settings → Providers and enable Kiro.

The provider card then shows the CLI version, the account you are logged in as, and the models
your account can use. If it says Kiro is not authenticated, run `kiro-cli login` again on the
server machine — not on the device you are browsing from.

## Settings

```text
Binary path:     kiro-cli
KIRO_HOME path:  empty
Agent:           empty
```

**Binary path**: leave it alone unless `kiro-cli` is not on the server's `PATH`. Editors and
launchers often have a narrower `PATH` than your shell, so an absolute path such as
`~/.local/bin/kiro-cli` is the reliable fix.

**KIRO_HOME path**: points Kiro at a different home directory, which scopes its agents, settings,
and saved sessions. Useful when you want one T3 Code instance using a separate set of agents.
Note that it does **not** separate logins: Kiro keeps credentials outside its home directory, so
every instance shares one account.

**Agent**: the Kiro agent new threads start with, for example `kiro_planner`. Leave it empty to use
Kiro's default agent. Run `kiro-cli agent list` to see what you have.

## Models

The model picker lists whatever your Kiro account offers, including `auto`, which lets Kiro choose
per task. You can switch models inside a running thread — no new thread needed.

## Using More Than One Kiro Setup

Add a second Kiro provider in Settings → Providers, give it its own display name, and point its
KIRO_HOME at a different directory. Both instances share your Kiro login, so this is for keeping
separate agent sets and session histories rather than separate accounts.

## Slash Commands

Kiro's slash commands work by typing them into the composer — `/tools`, `/context`, and the rest
go straight to Kiro. They do not appear in T3 Code's autocomplete yet, and the ones that expect
Kiro's own terminal interface will not render usefully here.

## What Works Differently

**Permission modes**: Full access runs without prompting. Supervised, Auto-accept edits, and Auto
all ask before each action, because Kiro does not expose a way to tell routine work from risky
work. See [Permission Modes](./permission-modes.md).

**Plan and Implement modes**: not available for Kiro. Kiro's equivalent of a planning mode is a
separate agent, so pick one with the **Agent** setting above rather than the mode control.

**Reverting a checkpoint**: T3 Code can restore your files, but it cannot make Kiro forget the
turns it has already seen, so a revert that rolls back turns reports an error. The files are still
restored. Starting a new thread is the clean way to drop that context. Grok behaves the same way.

**Thinking**: when Kiro reasons before answering, that reasoning shows up as thinking rather than
as part of the reply.
