# Grok Build

Run xAI's [Grok Build CLI](https://x.ai/cli) in Hyakki using your xAI subscription or `XAI_API_KEY`.

## Set up Grok Build

1. Install the Grok Build CLI (`@xai-official/grok`) on the machine running your Hyakki server.
2. Authenticate on that machine:
   - Run `grok login` (or `grok login --device-auth` on a headless/remote host), **or**
   - Set `XAI_API_KEY` in the Grok instance's **Environment** settings.
3. Open **Settings → Providers**, enable **Grok Build**, and refresh. Set **Binary path** if `grok` isn't on the server's `PATH`.

- **Multiple accounts**: Use a separate `GROK_HOME` environment variable per provider instance to isolate logins and usage.
- **Updates**: In-app updates follow your install method (standalone script, Homebrew, mise, or Nix—update Nix and pinned installs via their package manager).

## Capabilities and limits

- **Models & options**: Discovers models and reasoning effort levels from Grok Build. Add unlisted models under **Custom models**.
- **Permission modes**: Supports **Supervised**, **Auto** (Grok reviews routine actions and forwards remaining approvals to you), and **Full access**. **Auto-accept edits** is not supported (runs as Supervised). File approvals offer session-wide allow; command approvals are per-request.
- **Skills**: Grok skills appear in the composer's `$` menu.
- **Usage & limits**: Subscription limits under **Usage → Limits** require `grok login` (not `XAI_API_KEY` or custom endpoints). Usage totals only include turns with saved completed-turn records.
- **Not supported**: Conversation rewind (**Edit from here**) and the Plan interaction mode toggle.

## Troubleshooting

- **Provider check timeouts**: Startup checks in large directories can take 9–14 seconds. If discovery times out, set `HYAKKI_GROK_PROBE_TIMEOUT_MS=60000` in the server's environment and restart ([Provider check timeouts](./install.md#provider-check-timeouts)).
