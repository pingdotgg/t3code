# Hyakki docs

## Using Hyakki

New to Hyakki? Start with the **[User Guide & Index](./user/README.md)** for how Hyakki works, prerequisites, expectations, and the complete directory of feature guides.

### Essentials

- [Install Hyakki](./user/install.md) · [Welcome page](./user/welcome-page.md) · [FAQ](./user/faq.md)
- [Working with threads](./user/thread-sidebar.md) · [Messages and context](./user/composer.md) · [Permission modes](./user/permission-modes.md)
- [Diffs and workspace files](./user/diffs.md) · [Source control](./user/source-control.md) · [Subagents and delegation](./user/subagents.md)
- [Settings and project overrides](./user/project-settings.md) · [Project config (`t3.json`)](./user/t3-json.md) · [Multi-repo projects](./user/multi-repo-projects.md)

### Workspace tools & automation

- [Built-in browser](./user/browser.md) ([import sessions](./user/browser-import.md) · [default browser](./user/default-browser.md)) · [Devices](./user/devices.md)
- [Terminal](./user/terminal.md) · [Visual replies & MCP apps](./user/html-renders.md) · [SnapShots](./user/snap-shot.md) · [Voice input](./user/voice-input.md)
- [Workflows](./user/workflows.md) · [Text generation models](./user/text-generation.md) · [Prompt links](./user/prompt-links.md)
- [Activity log](./user/activity-log.md) · [Appearance and themes](./user/appearance.md) · [Keybindings](./user/keybindings.md) · [Keyboard focus](./user/keyboard-focus.md)

### Remote, security & operations

- [Remote access](./user/remote-access.md) · [Mobile notifications](./user/mobile-notifications.md) · [Guest links](./user/guest-links.md)
- [Outside agents (MCP)](./user/outside-agents.md) · [Secrets](./user/secrets.md) ([1Password service account](./user/secrets-1password-service-account.md) · [1Password Connect](./user/secrets-1password-connect.md))
- [Background service](./user/background-service.md) · [Updating Hyakki](./user/updating.md) · [Usage and limits](./user/usage.md) · [Maintenance & diagnostics](./user/diagnostics.md)
- [CLI reference (`t3`)](./user/cli.md) · [Usage data](./user/telemetry.md) · [Managed policy](./user/managed-policy.md) · [Triage an issue](./user/triage.md) · [V1 migration](./user/thread-migration.md) · [Portable handoffs](./user/portable-handoffs.md) · [Question attachments](./user/question-attachments.md) · [Open source licenses](./user/open-source-licenses.md)

### Providers

[Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Cursor](./user/cursor.md) · [Grok Build](./user/providers-grok.md) · [Antigravity](./user/providers-antigravity.md) · [OpenCode](./user/providers-opencode.md) · [Kiro](./user/providers-kiro.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) · [fx](./user/providers-fx.md) · [ACP providers](./user/providers-acp.md)

---

## Working on Hyakki

Start with the [development runbook](./operations/00_development.md),
and [contribution policy](../CONTRIBUTING.md).

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
- [07 · Server updates](./internals/07_server-updates.md)
- [08 · No product analytics](./internals/08_product-analytics.md)
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
- [03 · Release](./operations/03_release.md)
- [04 · Observability](./operations/04_observability.md)
