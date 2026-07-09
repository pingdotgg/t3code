# Grok

This guide is for people who want to use xAI Grok through SergeCode.

## Install Grok

Install the Grok CLI:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then confirm the `grok` command is available in the same shell environment that starts the
SergeCode server:

```bash
grok --version
```

## Log In

For an interactive terminal, run:

```bash
grok login
```

For a headless machine, use device auth:

```bash
grok login --device-auth
```

You can also authenticate with an xAI API key by setting `XAI_API_KEY` in the Grok provider's
Environment variables section in Settings. Mark the value as sensitive.

The Grok CLI stores login credentials in:

```text
~/.grok/auth.json
```

## Configure SergeCode

In Settings, your Grok provider can usually stay like this:

```text
Display name: Grok
Binary path: grok
```

If the server cannot find `grok` on its `PATH`, set `Binary path` to the full command path.

Example:

```text
Binary path: ~/.local/bin/grok
```

## Models

SergeCode discovers Grok models from the installed CLI. With current Grok CLI builds, new Grok
threads default to:

- `grok-4.5` — frontier model, with Low, Medium, and High reasoning choices
- `grok-composer-2.5-fast` — fast composer model

`grok-build` only appears when discovery is unavailable or an older Grok CLI advertises it. When
discovery succeeds, SergeCode only shows the model slugs reported by the CLI.

Reasoning effort is passed to `grok agent` when the session starts. Changing the reasoning selector
on an already-running Grok thread takes effect the next time SergeCode starts a Grok session for that
thread.

## Subagents

Grok sessions receive the `t3-code` MCP server automatically.

That means Grok can use `agent_spawn` to start subagents on other configured providers, and agents
running on other providers can start Grok subagents when Grok is available.
