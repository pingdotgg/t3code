# Roadmap

Status of the Continuum IDE plan. A feature is listed as **done** only when it is implemented,
integrated, and tested. Features inherited from T3 Code are marked _(upstream)_.

## Done

| Feature                                                              | Notes                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Independent fork and identity                                        | Name, icons, app ID, installer names, `~/.continuum` data folder, update feed pinned to this repository |
| Central branding module                                              | `packages/shared/src/branding.ts`                                                                       |
| Window transparency                                                  | Settings → Appearance; instant on Windows/macOS, one restart on Linux, remembered across launches       |
| Analytics off by default                                             | No default endpoint; opt-in only                                                                        |
| CI and releases                                                      | GitHub Actions: lint, typecheck, tests, Linux and Windows installers, GitHub Releases                   |
| Nix development shell                                                | `flake.nix`                                                                                             |
| Multi-agent support _(upstream)_                                     | Claude Code, Codex, Antigravity, Cursor, OpenCode, Grok, Kiro, Pi, Muse Code, fx, ACP                   |
| Multiple accounts per agent _(upstream)_                             | Provider instances                                                                                      |
| Cross-agent handoffs _(upstream)_                                    | Budgeted conversation handoff when switching agents                                                     |
| Persistent threads, search, pin, archive _(upstream)_                | Local SQLite                                                                                            |
| Git, worktrees, diffs, checkpoints _(upstream)_                      |                                                                                                         |
| Terminal, in-app browser, live preview, element picking _(upstream)_ |                                                                                                         |
| Usage dashboard _(upstream)_                                         | Token and cost estimates from local history                                                             |
| Automatic agent updates                                              | Settings → Provider updates; vendor builds in `~/.continuum/tools`, own installs untouched, revertible  |
| Local models through Ollama                                          | Settings → Local models: install, hardware checks, downloads, agent use through Codex                   |
| Memory vaults                                                        | Per-conversation Markdown vaults, access levels, relevant-section retrieval, agent tools                |
| Default account and assisted switching                               | Default/fallback model _(upstream)_; **Continue on …** on usage-limit banner, never automatic           |
| Thread tabs and split view                                           | Drag, pin, close/reopen, keyboard switching, two threads side by side; saved across restarts            |

## Planned

| Feature                                          | Plan                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| More tab kinds and layouts                       | Editor, terminal, browser, and settings tabs; more than two panes; named saved layouts       |
| Built-in code editor                             | Monaco editor with tabs, search/replace, formatting, language features                       |
| Account Manager page                             | One page listing every account with its limits                                               |
| Agent Eyes                                       | Live follow of edits, commands, tests, and browser activity; timeline, replay, explanations  |
| Session export/duplicate                         | Versioned export format                                                                      |
| Adaptive Intelligence Engine                     | Optimization profiles (Native default), benchmarks against native behavior before any claims |
| Simple / Advanced modes                          | Same capabilities, different density                                                         |
| Multi-agent activity center                      | Overview of running agents, approvals, and errors                                            |
| Signed installers, AUR, nixpkgs, macOS downloads | Need certificates or maintainers                                                             |
| Rebranded CLI (`continuum` instead of `t3`)      | The bundled CLI keeps upstream's `t3` name for now                                           |
