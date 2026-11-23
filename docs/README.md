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

### Architecture and boundaries

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Environment auth](./internals/environment-auth.md)
- [Remote environments](./internals/remote.md)
- [T3 Connect](./internals/t3-connect.md)
- [Server updates](./internals/server-updates.md)
- [Product analytics](./internals/product-analytics.md)
- [Performance regression checks](./internals/performance-regressions.md)
- [Mobile layout](./internals/mobile-layout.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)

### Conventions

- [Effect services](./internals/effect-services.md)
- [Web UI](./internals/web-ui.md)
- [Testing](./internals/testing.md)
- [Translating the UI (i18n)](./internals/i18n.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Dev container](./operations/devcontainer.md)
- [Scenarios: real-app proof for a fix](./operations/scenarios.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
