# Pi

This guide is for people who want to use the Pi coding agent in T3 Code.

Pi support is **Early Access** and is disabled by default. You opt in from Settings, and
Pi runs through its own `~/.pi/agent` configuration — the same setup the `pi` CLI uses.

## Before You Start

Install the Pi CLI and make sure it is on your `PATH`:

```bash
pi --version
```

Pi does not have a single `login` command like Codex or Claude. Instead, Pi talks to
upstream model providers (for example Google, Anthropic, or xAI) using per-provider API
keys stored under `~/.pi/agent`. Configure at least one provider with the Pi CLI before
using Pi in T3 Code, then confirm it works:

```bash
pi --list-models
```

If that prints models, Pi is ready.

## Enable Pi In T3 Code

Pi is off by default. Turn it on in Settings.

In Settings, your Pi provider looks like this:

```text
Display name: Pi
Binary path: pi
```

An empty (or `pi`) `Binary path` uses the `pi` binary from your `PATH`. Point it at an
absolute path if you run a specific build.

## Where Pi Keeps Its Config

Pi reads auth, models, and settings from a single directory:

```text
~/.pi/agent/auth.json       upstream provider API keys
~/.pi/agent/models.json     enabled models
~/.pi/agent/settings.json   default provider/model, packages, theme
```

T3 Code uses this directory as-is, so the models and providers you see in T3 Code match
what the `pi` CLI shows.

To point Pi at a different config directory, set `PI_CODING_AGENT_DIR` in the Pi provider's
Environment variables section in Settings. This is the Pi equivalent of a separate home,
and is useful if you want work and personal Pi setups.

## Which Models Are Available?

T3 Code discovers Pi models live. When it checks Pi's status, it briefly starts
`pi --mode rpc` and asks Pi for its available models, then appends any custom models you
configured. The result is exactly the model catalog your `~/.pi/agent` configuration
exposes.

If discovery fails or times out, T3 Code falls back to your custom models only. Enable more
models with the Pi CLI (`pi config`) or by editing `~/.pi/agent/models.json`, then refresh
provider status in Settings.

## How Tool Approval Works

Pi has no built-in per-tool approval prompt, so T3 Code adds one with a small bundled Pi
extension. Tool approval is selected through T3 Code's session/runtime approval mode, not a
Pi provider setting — pick it from the runtime-mode control in the composer (for example
**Supervised** or **Auto-accept edits**) or in the project thread options. **Full access**
turns approval off.

When the active session/runtime mode requires approval, T3 Code gates every tool call that
is not read-only.

Read-only tools run without asking:

```text
read   grep   find   ls   glob
```

Everything else — including `bash`, `write`, `edit`, and any unknown or custom tool — is
**denied unless you approve it**. This is a default-deny gate: unfamiliar tools are treated
as unsafe rather than trusted.

T3 Code will not run an ungated Pi session when the active mode requires approval. Before
allowing a tool-capable turn, it verifies that the approval extension actually loaded. If
the gate cannot be guaranteed active, T3 Code refuses to start the session rather than run
Pi with unguarded tools — there is no silent fallback to read-only or any other mode.

If you select **Full access** for the session, Pi runs tools without asking. Only do this
in environments where that is acceptable.

## Limitations

- **Early Access.** Expect rough edges.
- **Disabled by default.** You must enable Pi in Settings before it appears in the model
  picker.
- **Auth is inferred from model discovery.** Pi has no `login` command, so T3 Code reports
  Pi as authenticated when Pi returns available models (which requires a working provider or
  API key configured in `~/.pi/agent`), and shows a "no models available" warning otherwise.
  An invalid key surfaces as an error when you send a message. Use `pi --list-models` to
  confirm your keys work.
- **Config is shared with the Pi CLI.** Changes you make in `~/.pi/agent` affect both T3
  Code and the `pi` CLI. Use `PI_CODING_AGENT_DIR` to isolate a setup.
