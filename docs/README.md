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

Start with the [development runbook](./operations/00_development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal docs preserve architectural decisions, trust boundaries, conventions, and cross-cutting
traps that the source alone does not explain. Most code changes do not need an internal
documentation update. Follow the [documentation rules](../AGENTS.md#documentation) before adding
anything.

### Internals (in reading order)

- [00 · Glossary](./internals/00_glossary.md)
- [01 · Architecture](./internals/01_architecture.md)
- [02 · Effect services](./internals/02_effect-services.md)
- [03 · Providers](./internals/03_providers.md)
- [04 · Environment auth](./internals/04_environment-auth.md)
- [05 · Remote environments](./internals/05_remote.md)
- [06 · T3 Connect](./internals/06_t3-connect.md)
- [07 · Server updates](./internals/07_server-updates.md)
- [08 · Product analytics](./internals/08_product-analytics.md)
- [09 · Connection runtime](./internals/09_connection-runtime.md)
- [10 · Web UI](./internals/10_web-ui.md)
- [11 · Mobile layout](./internals/11_mobile-layout.md)
- [12 · Mobile navigation](./internals/12_mobile-navigation.md)
- [13 · Mobile development lifecycle](./internals/13_mobile-development.md)
- [14 · Translating the UI (i18n)](./internals/14_i18n.md)
- [15 · Testing](./internals/15_testing.md)
- [16 · Performance regression checks](./internals/16_performance-regressions.md)
- [17 · Scripts](./internals/17_scripts.md)

### Runbooks

- [00 · Development and local builds](./operations/00_development.md)
- [01 · Dev container](./operations/01_devcontainer.md)
- [02 · T3 Connect setup](./operations/02_connect-setup.md)
- [03 · Release](./operations/03_release.md)
- [04 · Observability](./operations/04_observability.md)
- [05 · Relay observability](./operations/05_relay-observability.md)
