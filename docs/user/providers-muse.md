# Muse Code

Run [Muse Code](https://dev.meta.ai/docs/muse-code) on your HYR Code server. Muse Code is disabled by default.

## Set up Muse Code

1. Install Muse Code on the server machine and run `muse login` as the user running HYR Code.
2. Open **Settings → Providers**, select the environment, enable **Muse Code** (set **Binary path** if not on `PATH`), and refresh provider status.

> Note: Provider status does not verify login—if you are signed out, turns fail until you run `muse login` on the host.

- **API key**: HYR Code ignores inherited server `META_API_KEY`. To bill an instance via API key instead of `muse login`, add `META_API_KEY` in that instance's **Environment** settings (overrides the saved login).
- **Multiple instances**: Instances on the same host share `muse login` unless given their own `META_API_KEY`.
- **Updates**: In-app updates work when HYR Code recognizes the Muse launcher; otherwise update Muse on the host manually.

## Models, permissions, and limitations

- **Models**: Reported by Muse on the host (refresh provider status after config changes). If a listed model fails with an access error, pick another or add an allowed ID under **Custom models**.
- **Permission modes**: Supports **Supervised** and **Full access** only (**Auto** and **Auto-accept edits** are unavailable).
- **Skills**: Muse loads its own skills (`muse skills` on the host); they do not appear in the composer's `$` menu.
- **Forks & rewind**: Forking starts a new session with copied conversation context; conversation rewind is not supported.
- **T3 tools**: Muse can use HYR Code's MCP tools when reachable (turns continue without them if unavailable).
