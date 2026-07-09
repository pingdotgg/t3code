# Fugu

This guide is for people who want to use Sakana AI Fugu through SergeCode.

Fugu is Sakana AI's model family, served through a Codex-compatible CLI
(`codex-fugu`).

## Install codex-fugu

Follow Sakana's install instructions for `codex-fugu`. After install, these
files should exist:

```text
~/.codex/fugu.json          # model catalog
~/.codex/fugu.config.toml
```

You also need the real OpenAI Codex binary (`codex`) on the PATH used by the
SergeCode server. Fugu does **not** run `codex-fugu` (see below).

## How SergeCode runs Fugu

SergeCode does **not** launch `codex-fugu`. That binary is a bash wrapper that
runs `codex -p fugu`, and Codex rejects `--profile` for the `app-server`
subcommand SergeCode uses.

Instead, SergeCode runs the real `codex` binary with a dedicated `CODEX_HOME`
(default `~/.codex/fugu-home`). On first use it bootstraps that home
automatically — writing a `config.toml` that points at the Sakana API and the
model catalog at `~/.codex/fugu.json`. An existing `config.toml` is never
overwritten.

## Authenticate

Set the `SAKANA_API_KEY` environment variable in the Fugu provider's
Environment variables section in Settings. Mark the value as sensitive.

## Configure SergeCode

In Settings, your Fugu provider can usually stay like this:

```text
Display name: Fugu
Binary path: codex
CODEX_HOME path: ~/.codex/fugu-home
```

`Binary path` must be the real Codex binary (`codex`), **not** `codex-fugu`.

If the server cannot find `codex` on its `PATH`, set `Binary path` to the full
command path.

Example:

```text
Binary path: /usr/local/bin/codex
```

## Models

- `fugu` (default) — Sakana's go-to model; best balance of cost and performance
- `fugu-ultra` — choose only for complex tasks where quality is top priority

Both models support reasoning efforts **High** and **Extra High** only
(`high` / `xhigh`). There is no Low or Medium. Both use a 1M-token context
window.

## Troubleshooting

**"Fugu model catalog not found"** — install `codex-fugu` first so
`~/.codex/fugu.json` is present. SergeCode reads that catalog and will not
bootstrap a Fugu home without it.
