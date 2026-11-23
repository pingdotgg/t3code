# T3 Code docs

## Using T3 Code

- [Install T3 Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Projects with several repositories](./user/multi-repo-projects.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Voice input](./user/voice-input.md)
- [Text generation models](./user/text-generation.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Use T3 Code as your default browser](./user/default-browser.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Secrets](./user/secrets.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Guest links](./user/guest-links.md)
- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Running in the background](./user/background-service.md)
- [Updating T3 Code](./user/updating.md)
- [Triage an issue](./user/triage.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Kiro](./user/providers-kiro.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) · [fx](./user/providers-fx.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal docs preserve architectural decisions, trust boundaries, conventions, and cross-cutting
traps that the source alone does not explain. Most code changes do not need an internal
documentation update. Follow the [documentation rules](../AGENTS.md#documentation) before adding
anything.

### Internals (in reading order)

- [00 · Glossary](./internals/00.glossary.md)
- [01 · Architecture](./internals/01.architecture.md)
- [02 · Effect services](./internals/02.effect-services.md)
- [03 · Providers](./internals/03.providers.md)
- [04 · Environment auth](./internals/04.environment-auth.md)
- [05 · Remote environments](./internals/05.remote.md)
- [06 · T3 Connect](./internals/06.t3-connect.md)
- [07 · Server updates](./internals/07.server-updates.md)
- [08 · Product analytics](./internals/08.product-analytics.md)
- [09 · Connection runtime](./internals/09.connection-runtime.md)
- [10 · Web UI](./internals/10.web-ui.md)
- [11 · Mobile layout](./internals/11.mobile-layout.md)
- [12 · Mobile navigation](./internals/12.mobile-navigation.md)
- [13 · Mobile development lifecycle](./internals/13.mobile-development.md)
- [14 · Translating the UI (i18n)](./internals/14.i18n.md)
- [15 · Testing](./internals/15.testing.md)
- [16 · Performance regression checks](./internals/16.performance-regressions.md)
- [17 · Scripts](./internals/17.scripts.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Dev container](./operations/devcontainer.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
