# Kimi

This guide is for people who want to use Moonshot AI’s Kimi Code CLI through SergeCode.

## Install Kimi Code CLI

Install with the official script (no Node.js required):

```bash
# macOS / Linux
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

Then confirm the `kimi` command is available in the same shell environment that starts the
SergeCode server:

```bash
kimi --version
```

## Log In

For an interactive terminal, run:

```bash
kimi login
```

You can also authenticate with a Moonshot / Kimi API key by setting `KIMI_API_KEY` or
`MOONSHOT_API_KEY` in the Kimi provider’s Environment variables section in Settings. Mark the
value as sensitive.

The CLI stores login credentials under:

```text
~/.kimi-code/credentials/
```

## Configure SergeCode

In Settings, your Kimi provider can usually stay like this:

```text
Display name: Kimi
Binary path: kimi
```

If the server cannot find `kimi` on its `PATH`, set `Binary path` to the full command path.

Example:

```text
Binary path: ~/.kimi-code/bin/kimi
```

## Models

SergeCode discovers Kimi models from the installed CLI over ACP (`kimi acp`). With current Kimi
Code CLI builds, new Kimi threads default to:

- `kimi-code/k3` — frontier K3 model (default), with Low, High, and Max thinking choices
- `kimi-code/kimi-for-coding` — K2.7 Coding
- `kimi-code/kimi-for-coding-highspeed` — K2.7 Coding Highspeed

When discovery succeeds, SergeCode only shows the model slugs reported by the CLI. Thinking effort
is applied through the ACP `thinking` session config option when the selected model supports it.

## Subagents

Kimi sessions receive the `t3-code` MCP server automatically when subagent orchestration is
available, so Kimi can spawn subagents on other configured providers and other providers can spawn
Kimi subagents when Kimi is ready.
