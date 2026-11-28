# T3 Code User Guide

Welcome to T3 Code. This guide explains how T3 Code works, what you need before starting, what to expect, and where to find documentation for every feature.

## How T3 Code works

T3 Code is an open-source control plane for coding agents. It gives the coding agents already installed on your computer (or server) one fast, unified interface across **desktop**, **web** (`app.t3.codes` or local), and **mobile** (iOS and Android).

### Core concepts

- **Host (Environment) vs. Clients**: A T3 Code **server** runs on the machine that holds your code and provider CLIs (your laptop, desktop, workstation, or VPS). Your desktop app, browser, and phone are **clients** connected to one or more environments.
- **T3 Code is not a harness**: It drives the agent harnesses you already have—Claude Code, Codex, Cursor, Grok Build, Google Antigravity, OpenCode, Kiro, Pi, Muse Code, fx, or any [ACP](./providers-acp.md) agent. You can switch providers or models mid-thread and even let one agent delegate tasks to another.
- **Projects**: A project points to a folder on an environment (a single Git repo, a [multi-repo folder](./multi-repo-projects.md), or a plain folder). You can also start scratch threads [without a project](./thread-sidebar.md#start-without-a-project).
- **Threads & Worktrees**: Each task gets its own **thread**. Run a thread in the project's main checkout, or choose **New worktree** to give it an isolated Git branch and working directory so multiple agents can work in parallel without stepping on each other.
- **Permission modes**: Control per thread whether an agent asks before acting (**Supervised**), auto-approves file edits (**Auto-accept edits**), uses provider auto-review (**Auto**), or runs without prompts (**Full access**).

## Prerequisites and expectations

- **Bring your own subscription or API keys**: T3 Code is free and does not resell tokens. You need at least **one installed, authenticated provider** on the host machine before starting a thread (Codex via ChatGPT and Google Antigravity can install and sign in directly from T3 Code).
- **Code stays on your machine**: Your code and prompts go directly from your host machine to your chosen provider—never through T3 Code servers.
- **Your host must stay awake**: Your phone and `app.t3.codes` are remote controls. If the host machine sleeps or shuts down, agents pause until it wakes. Use the [background service](./background-service.md) for always-on hosts.
- **Git is optional but unlocks the best features**: Branching, isolated worktrees, turn diffs, and one-click PRs require a Git repository (and a signed-in host CLI or token for PRs/issues).
- **No local-model focus**: T3 Code is designed for frontier coding agents (though OpenAI-compatible local endpoints like Ollama can be used for lightweight [text generation](./text-generation.md) like thread titles).
- **Device vs. server settings**: Appearance, keybinding preferences, and saved PR views live per device; provider configs, thread rules, worktree cleanup, and scheduled tasks live on each server environment (with per-project overrides).

## Quickstart

1. **Install T3 Code** on the machine where your agents will run ([Install T3 Code](./install.md)).
2. **Set up at least one agent** via the [Welcome page](./welcome-page.md) or **Settings → Providers** (for example, `claude auth login` or `codex login`).
3. **Open or clone a project** and start a thread ([Working with threads](./thread-sidebar.md)).
4. **Optional — connect your phone or another computer**: Run `t3 up` on the host or enable **T3 Connect** in **Settings → Sharing & access** ([Remote access](./remote-access.md)).

---

## Documentation index

### Getting started

- [Install T3 Code](./install.md) — Desktop app, `t3` CLI, mobile app, WSL, and provider setup.
- [Welcome page](./welcome-page.md) — First-run setup and importing existing Claude, Codex, and Pi sessions.
- [FAQ](./faq.md) — Common questions on pricing, subscriptions, privacy, limits, and troubleshooting.
- [Threads from older T3 Code versions](./thread-migration.md) — V1 → V2 database migration and recovery backups.

### Everyday workflow

- [Working with threads](./thread-sidebar.md) — Starting threads, scratch threads, pinning, settling, snoozing, archiving, and side chats.
- [Messages and context](./composer.md) — Composer formatting, attachments, queueing/steering, `@` threads/models, `#` PRs, `/goal`, stash, and rewind.
- [Permission modes](./permission-modes.md) — Supervised, Auto-accept edits, Auto, Full access, push-hook prompts, and provider differences.
- [Diffs and workspace files](./diffs.md) — Turn diffs, branch comparisons, commits view, file editor, and inline review comments.
- [Source control](./source-control.md) — GitHub, GitLab, Forgejo/Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin, Linear and Jira issues, PR review guides, stacks, and PR watching.
- [Activity log](./activity-log.md) — Inspecting tool calls, hiding work logs / Zen mode, and screen reader announcements.
- [Subagents and delegation](./subagents.md) — Parallel T3-delegated and provider-native subagents.
- [Context in portable handoffs](./portable-handoffs.md) — How conversation context transfers across provider switches and forks.
- [Files in question answers](./question-attachments.md) — Attaching files and images when answering agent questions.
- [Terminal](./terminal.md) — Integrated host terminals, scrollback limits, custom shells, and fish config.

### Workspace tools & media

- [Built-in browser](./browser.md) — Preview tabs, profiles, viewports, element picker, annotations, recordings, and agent browser access.
- [Import browser sessions](./browser-import.md) — Copying cookies from Chrome, Safari, Firefox, Zen, or Helium into the desktop preview browser.
- [Use T3 Code as your default browser](./default-browser.md) — Opening links and HTML files in T3 Code on macOS.
- [Devices](./devices.md) — Live iOS Simulators, Android Emulators, physical Android devices, SSH device hosts, and Simlock pools.
- [Visual replies and MCP apps](./html-renders.md) — Inline HTML charts/diagrams/mockups and interactive MCP Apps.
- [SnapShots](./snap-shot.md) — Desktop window capture with accessibility text attached to drafts.
- [Voice input](./voice-input.md) — On-device, environment, and cloud speech-to-text dictation and transcript cleanup.
- [Prompt links](./prompt-links.md) — Shareable prefilled draft links and thread links.

### Projects, automation & customization

- [Settings and project overrides](./project-settings.md) — Scope inheritance, pinning/archiving projects, worktree cleanup, scheduled tasks, and webhooks.
- [Project configuration (`t3.json`) and actions](./t3-json.md) — Checked-in repo config, setup/dev/settle scripts, and schema reference.
- [Projects with several repositories](./multi-repo-projects.md) — Multi-repo folders, external folders, submodules, and custom worktree layouts.
- [Workflows](./workflows.md) — Durable multi-stage TypeScript workflows (Labs) with schedules, webhooks, and approvals.
- [Text generation models](./text-generation.md) — Fast/cheap API models for titles, commits, PR descriptions, and voice cleanup.
- [Appearance and themes](./appearance.md) — Built-in themes, custom palettes/CSS, background images, LaTeX math, and environment themes.
- [Keybindings](./keybindings.md) — Shortcuts, `keybindings.json` syntax, `when` conditions, and hardware keyboards.
- [Keyboard focus](./keyboard-focus.md) — Full keyboard workspace navigation (`F6`, sidebar, and settings).

### Providers

- [Codex](./providers-codex.md) — ChatGPT sign-in, CLI/shadow-home multi-account, image generation, async questions, Daybreak.
- [Claude](./providers-claude.md) — Multi-account `CLAUDE_CONFIG_DIR`, idle compaction, skills, MCP OAuth, Claude in Chrome, OpenRouter.
- [Cursor](./cursor.md) — Local Cursor SDK sign-in, MCP/plugins, and Windows sandbox notes.
- [Grok Build](./providers-grok.md) — Grok CLI setup, `XAI_API_KEY`, `GROK_HOME`, and permissions.
- [Antigravity](./providers-antigravity.md) — Managed runtime, Google/Vertex sign-in methods, skills, and multiple accounts.
- [OpenCode](./providers-opencode.md) — OpenCode 1.x/2.x, local vs. external servers, compaction, and approvals.
- [Kiro](./providers-kiro.md) — Kiro CLI V3, custom agents, and permissions.
- [Pi](./providers-pi.md) — Pi setup, extensions, thinking/speed tiers, and folder trust.
- [Muse Code](./providers-muse.md) — Muse CLI, `META_API_KEY`, and limitations.
- [fx](./providers-fx.md) — fx backends, effort, skills, and permissions.
- [ACP providers](./providers-acp.md) — ACP Registry agents and local ACP commands.

### Remote, mobile & integrations

- [Remote access](./remote-access.md) — T3 Connect, LAN/Tailscale pairing, desktop SSH, multi-route failover, load balancing, and linked environments.
- [T3 Connect troubleshooting](./t3-connect-troubleshooting.md) — Diagnosing tunnel, port 7844, DNS, clock, and account errors.
- [Mobile notifications](./mobile-notifications.md) — Push alerts, iOS Live Activities/widgets, and Android Live Updates.
- [Guest links](./guest-links.md) — Sharing a live thread with a teammate in their browser (no account needed).
- [Outside agents](./outside-agents.md) — Connecting Claude Code, Codex, ChatGPT, or bots to T3 Code over MCP, plus `t3 thread` host scripting.
- [Secrets](./secrets.md) — 1Password CLI references and private in-thread agent secret cards.
- [1Password service account](./secrets-1password-service-account.md) — Headless 1Password setup with a service account token.
- [1Password Connect](./secrets-1password-connect.md) — Headless 1Password setup with a Connect server.

### Operations, monitoring & admin

- [Running T3 Code in the background](./background-service.md) — Background user service, `service.env`, Linux OOM protection, and `t3 doctor`.
- [Updating T3 Code](./updating.md) — Updating desktop, servers, providers, Stable/Nightly tracks, and restart continuation.
- [Usage and limits](./usage.md) — Token/cost tracking, custom model pricing, pooled subscription quotas, CLIProxyAPI hubs, and HTTP quota sources.
- [Maintenance, power, and diagnostics](./diagnostics.md) — Background activity profiles, keep awake, Diagnostics UI, and `t3 trace`.
- [CLI reference (`t3`)](./cli.md) — Complete overview of `t3` subcommands.
- [Product usage data and diagnostics](./telemetry.md) — Telemetry opt-outs, agent feedback, mobile diagnostics, and OTLP export.
- [Triage an issue](./triage.md) — Letting an agent investigate a T3 Code bug and draft an issue.
- [Managed policy](./managed-policy.md) — Machine-wide enterprise configuration via JSON, macOS profiles, and Windows GPO/registry.
- [Open source licenses](./open-source-licenses.md) — Viewing third-party license notices in the app.
