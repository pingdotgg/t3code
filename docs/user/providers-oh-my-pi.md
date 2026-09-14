# Oh My Pi (omp)

Oh My Pi runs as T3 Code's agent through its own ACP server (`omp acp`). T3 Code
starts one omp process per thread in that thread's project directory, so
everything omp reads from your machine still applies: the credentials under
`~/.omp`, your `models.yml`, skills, plugins, extensions, hooks, rules,
`AGENTS.md`, and MCP servers. T3 Code manages no keys of its own for omp.

## Setup

Install [Oh My Pi](https://github.com/can1357/oh-my-pi), run `omp` once to sign
in, then enable **Oh My Pi** in **Settings → Providers**. The provider card shows
the detected version, how many upstream providers your omp config reaches, and
the accounts omp is authenticated with. If `omp` is not on the server's `PATH`,
set **Binary path** on the card.

When omp is behind its latest release, the card offers **Update now**, which runs
`omp update`. omp installs through whichever route it finds your copy came from
— Homebrew, mise, Bun, npm, or its own binary — so the update matches how you
installed it.

**Setup** (the first-run wizard) lists Oh My Pi next to Claude Code and Codex,
with the same inline terminal: **Install** pre-types omp's own installer, and
**Sign in** pre-types `omp setup`. Its **Projects** step also offers the
directories omp ran in, with their conversations.

## What carries over from the terminal

| Terminal feature                | In T3 Code                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Skills                          | `$name` in the composer; the menu lists every skill omp discovered           |
| Slash commands                  | `/` lists omp's own commands, including plugin and project commands          |
| Models and upstreams            | Model picker groups omp models by upstream provider; switching is in-session |
| Thinking levels                 | Reasoning selector, limited to the levels omp accepts for that model         |
| Approvals                       | Approval prompts in the thread; the mode maps to omp's approval flags        |
| Questions from skills and hooks | User-input requests in the thread                                            |
| Subagents (`task`)              | Agents panel, with per-agent progress and outcome                            |
| Todos                           | Plan panel, updated as omp rewrites its list                                 |
| Context and cost                | Context meter in the composer, fed by omp's own usage reports                |
| `/compact`                      | **Compact** button, which runs omp's compaction                              |
| Usage limits                    | Quota banner from `omp usage`                                                |
| Sessions started in a terminal  | Imported as threads and resumed in place                                     |
| `/rename`                       | Renames the thread too — omp's session title is the thread title             |
| `/fresh`                        | Starts omp's new provider session; the thread keeps running on it            |
| `/review`, `/security`, plugins | Their pickers arrive as in-thread questions, answered in the composer        |

Commands that only make sense in a terminal have a T3 Code equivalent instead:
the fullscreen git UI becomes the git panel and commit composer, `omp shell` and
PTY work become the terminal drawer, and Ctrl+P model cycling becomes the model
picker.

## Limits

- **No rewind.** omp can branch a session from an earlier entry in its terminal
  UI, but its ACP interface exposes no such call, so T3 Code cannot revert a
  conversation to an earlier turn. Fork the thread and continue instead.
- **Skill files are not openable.** omp reports a skill by name, not by path, so
  a skill chip shows its description without a "view instructions" link.
- **Menus follow the project.** Project-scoped skills and commands come from the
  thread's project directory; a thread in another project sees another set.
- **Approval behavior is chosen when omp starts.** omp takes it from launch
  flags, so a thread's permission mode applies from the next turn onward rather
  than to work already in flight.
- **Some commands only draw in omp's terminal.** `/instinct-*` and friends
  answer nothing over ACP. The turn then carries a note naming the command
  that stayed silent, instead of looking like nothing happened.
- **`/wt` and `/move` move omp, not the thread.** They change the directory omp
  works in; T3 Code keeps showing the project and branch the thread was opened
  with. Open a thread in the worktree instead.
- **`/pin` pins in omp.** It affects omp's own resume list, not the sidebar;
  pin the thread in T3 Code separately.
