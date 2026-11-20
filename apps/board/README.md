# Agent Board

A desktop app that runs projects through an orchestrator on the T3 Code engine. It connects to the local T3 background service as a client, like T3's mobile app does.

## The engine stays upstream

This fork tracks `pingdotgg/t3code`. Board code lives only in `apps/board/`, `.github/workflows/agent-board.yml`, and `pnpm-lock.yaml`, so merging upstream never conflicts. The check below enforces that and runs in CI on every pull request.

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git  # once
git fetch upstream main
node apps/board/scripts/check-engine-untouched.mjs
```

It exits 0 when nothing outside those paths changed since the merge base with `upstream/main`, 1 with the offending paths otherwise, and 2 when the `upstream` remote is missing.

## Run

```sh
vp run --filter @agent-board/app dev      # Electron window on the Vite dev server
vp run --filter @agent-board/app dev:web  # the renderer alone, in a browser, at http://127.0.0.1:5190
vp run --filter @agent-board/app build    # renderer to dist/, Electron main to dist-electron/
vp run --filter @agent-board/app start    # production build, loaded from agentboard://app
```

On a Windows machine, run the same commands from WSL with `dev:windows` and `start:windows` (after `build`) to get Windows' own window frame. They download Electron for `win32-x64` once into `%LOCALAPPDATA%\agent-board\` and copy the bundle there, so Electron never runs from a `\\wsl.localhost` path. This needs WSL mirrored networking, so the Windows app can reach the dev server on `127.0.0.1`.

`PORT` moves the dev server. `AGENT_BOARD_CDP_PORT` turns on Electron's remote debugging port. Electron prints `board:first-paint <ms>` once the renderer has painted, measured from the main process start.

## omp rules for Claude Code

The `omp-kit` plugin in `plugins/` gives every Claude Code session the rules in `~/.omp/agent/rules`, the sticky `~/.omp/agent/RULES.md`, a TypeScript language server for the `LSP` tool, and `vp` on the Bash path. Rules are read at hook time, so editing a rule file takes effect in the next session. `OMP_KIT_RULES_DIR` points the engine at another rules folder, and `RULES.md` is read from that folder's parent.

```sh
node apps/board/scripts/install-omp-kit.mjs                      # user scope, ~/.claude
node apps/board/scripts/install-omp-kit.mjs --config-dir /tmp/x  # an isolated Claude config
```

The plugin loads in place from this checkout, so install from a checkout that stays. The language server needs `typescript` installed in the project it opens.

## The engine

The app uses T3's own engine, the background service in WSL that `t3 service install` sets up and `t3 update` keeps current. It never runs an engine of its own and never stops one. It finds the engine in this order and shows each step in the sidebar footer.

1. `AGENT_BOARD_ENGINE_URL`, when set. `AGENT_BOARD_TOKEN` supplies its bearer; without it the app issues one.
2. Join a running engine. The app reads `userdata/server-runtime.json` under the T3 home in WSL, and joins when that `pid` is alive and the origin answers.
3. Start the service. When `t3` is current but no engine runs, the app runs `t3 service install`, which also repairs a broken service, then joins.
4. Install T3. When `t3` is missing, the footer asks once, then runs `curl -fsSL https://t3.codes/install.sh | sh` and `t3 service install` in WSL, then joins.
5. Update T3. When `t3` or the running engine is older than this client accepts, by the rule in `@t3tools/client-runtime/connection`, the footer asks once, then runs `t3 update --yes`, then joins. Declining leaves `Offline` with the found version.

While the app is open it holds one idle `wsl.exe` process so WSL does not shut down under the service, and ends it on quit.

On Windows every command runs through `wsl.exe -d <distro> --cd ~ --exec`, on Linux directly. The distro is WSL's default; `AGENT_BOARD_WSL_DISTRO`, or `wslDistro` in the app's `settings.json`, picks another from `wsl.exe --list --verbose`.

The app issues its bearer with `auth session issue --label agent-board --ttl 30d`, keeps it encrypted with Electron `safeStorage`, and checks it on every connection attempt. A rejected token is reissued once, then the footer shows `auth_failed`.

`AGENT_BOARD_T3_HOME` replaces `~/.t3`. `AGENT_BOARD_T3_CLI` replaces the discovered `t3` command. `dev:windows` forwards all of these to the Windows process. `t3 service install` always names the same `t3code.service` user unit, so `--base-dir` does not give it a unit of its own: a lane that installs the service needs its own WSL distro, such as one imported with `wsl.exe --import`.

`dev:web` has no main process. Pass `AGENT_BOARD_ENGINE_URL` and `AGENT_BOARD_TOKEN` to point it at an engine.

## Projects and usage

The `+` in the sidebar's Projects header adds a project. Its folder button opens the system folder dialog at the WSL home (`\\wsl.localhost\<distro>\home\<user>` on Windows), and a typed WSL path works too. The main process converts a Windows path with `wslpath -u` through the same WSL runner as the engine commands, then the renderer creates the project with the engine's `project.create`. A folder that is missing, on a Windows drive, or already a project shows its reason under the field.

The bar along the bottom of the window shows each provider's usage limits as T3 reports them in the server config (`providers[].usageLimits`), so the board never calls Anthropic or OpenAI. A session window reads `8% 5d 22h`, a model window `3% Fable`, and a provider without readable limits shows a dash with the reason on hover.

## Boards

The `+` on a project's header creates a board under it. A board is the folder `.agentboard/<slug>/` in the project, holding a `board.json` with `id`, `slug`, `name`, `projectId`, `orchestratorThreadId`, `createdAt`, `archived`, and `builderCap`. The folder name comes from the board's name (`Claude connector` becomes `claude-connector`, then `claude-connector-2`). `.agentboard/.gitignore` holds `*`, so the project's git never sees the folder. The sidebar reads the folder with `projects.listEntries` and `projects.readFile`, and writes with `projects.writeFile`, always with paths relative to the project, because `projects.listEntries` rejects an absolute `directoryPath`. A `board.json` that fails to decode shows as a row with an error badge naming the bad fields, and a project folder with no `.agentboard` has no boards.

The hover action on a board row archives it. Archiving sends `thread.stop` with `stopDelegatedTasks` to the board's orchestrator, waits until no thread of its family has a running task, archives the family's threads (children first), then sets `archived` in `board.json`. A board with no orchestrator thread only gets the file change. Archived boards fold into an `N archived boards` row, and each row inside it restores the board: the family's threads are unarchived from `orchestration.getArchivedShellSnapshot`, since `orchestration.getThreadFamily` lists only threads that are not archived, and `archived` goes back to false. Stopped agents stay stopped.

The last opened board lives in `local-state.json` in the app's user data folder, read and written through IPC (`localStorage` in `dev:web`).

## Orchestrators

Creating a board opens a dialog with the name and the **Orchestrator** picker. The picker lists the engine's Claude Code and Codex instances from the server config, each with its sign-in state and the models it offers. Type a model the instance does not list and the engine decides, as in T3.

On create, the app does this in order:

1. Writes the 18 role files from `roles/` into `<board folder>/roles/`.
2. Starts the orchestrator with `orchestration.launchThread` in the project root, with the rendered `src/orchestrator/brief.md` as its first message. The brief names the board folder by absolute path, the store files and who writes each, the ticket stages, the role registry, the builder cap, and the rule that the user is reached only through `foryou.jsonl` or `request_secret`.
3. Saves the thread id in `board.json`, then waits for the first sign of life. The dialog closes when the orchestrator has produced text. A model the instance does not offer makes the first run fail, which the engine reports only on the run, so the dialog shows that failure, the board goes back to having no orchestrator, and the failed thread is archived. **Try again** retries without a second board folder.

A board with no orchestrator offers the same picker in its panel.

The side panel streams the orchestrator thread and sends follow-ups with `startThreadTurn`. **Stop** interrupts the turn. A reload reattaches to the running thread. The first message, the brief, folds into a disclosure. The orchestrator card on the canvas reads `tickets.json`, `foryou.jsonl`, and `decisions.tsv` from the board folder every few seconds and shows tickets by stage, open For-you items, builders against the cap, and the latest decision.

### Roles

Every agent the orchestrator starts is a role from `src/orchestrator/roles.ts`, started with `delegate_task`: `role` is the role's `t3Role`, `isolation` is its isolation, `target` is its model, `title` is `[<ticket key>] <role name>`, and `task` starts with `Read <board folder>/roles/<role>.md and act as that role.` T3 cannot limit a child's tools, so a read-only role stays read-only only because its file says so.

The role files port omp's `task`, `scout`, `reviewer`, `security-reviewer`, and `sonic`, the `comment-sicko` and `poteto-agent` roles from pstack-omp, the two thermo-nuclear reviewers from thermos-omp, and the nine `egm-*` roles. The omp-only front matter (`tools`, `model`, `spawns`, `thinking-level`) is dropped, and an `output` schema became a `Return` section. The models copy omp's `modelRoles`: `reviewer` runs `claude-fable-5-1` at `xhigh`, `scout` runs `claude-sonnet-5-5` at `medium`, `task` runs `claude-sonnet-5-5` at `high`, `sonic` runs `claude-haiku-5-5` at `low`, and every other role runs `claude-opus-5-5` at `high`. A role whose Claude model the orchestrator's instance does not offer uses the orchestrator's model, and the brief says so under the registry table. A Codex orchestrator's children inherit its model.

### Sign-in

T3 can sign in only the instances whose `setup.canAuthenticate` is true, such as a Codex instance in managed mode. **Sign in** runs `provider.auth.start` and shows the step the engine waits on: the browser page, the device code, the terminal, or the credential fields. Claude Code signs in on the machine that runs T3, so for it the picker shows the engine's own instructions and a **Refresh** button.

### Timing tokens

With `localStorage["board:token-marks"] = "1"`, the panel marks `board:token-received` when a streamed token reaches the thread state and `board:token-painted` two frames after its text commits, each with the reply's length in `detail.length`.

## Artifacts

Agents leave evidence files, and the board shows each as a card. A ticket frame and the orchestrator card carry an artifact count, and pressing it opens the cards: under the frame for a ticket, beside the card for the board. `src/domain/artifact.ts` classifies a path under the board folder with a lookup table on the folder and the extension. `artifacts/<KEY>/` holds a ticket's evidence, and its extension says which: images are screenshots, `.sh` and `.mts` are scripts, `.patch` is a diff, `.md` and `README.txt` are reports, and everything else is a proof. `review/<KEY>/` is a review, `inbox/` is a brief, and the board root's `design.md`, `plan.md`, `brief.md`, and `decisions.tsv` are a design, a plan, a brief, and the decisions. Files for a key no ticket carries, and the board-level files, attach to the orchestrator card.

`store/artifacts.ts` lists the board folder one directory at a time with `projects.listEntries`, always with a path relative to its `cwd`, and again every second while the board is open, so a file an agent writes shows within a few seconds. It also lists `.omp/artifacts/` in each ticket's `worktreePath`, with the worktree as the `cwd`, because the engine refuses an absolute `directoryPath`.

Opening a card shows the file in the viewer over the canvas. An image loads from an `assets.createUrl` `media-file` URL, which the engine signs for an absolute path and serves without the app's credentials. The page's `img-src` allows `http://127.0.0.1:*` for that. Text and markdown come from `projects.readFile` with the absolute path, which the engine reads up to 1 MB of: past that the viewer says how much of the file it shows. A file the engine calls binary shows a placeholder. A ticket's `README.txt` shows as its files, each beside what it proves.

Each listing marks `board:artifacts-listed` with the file count and the milliseconds it took in `detail`.

## Pull requests and merge readiness

A ticket frame shows its pull request in a row under the branch: `PR #12 Open ✓ Passing Mergeable`, with the checks reading Passing, Failing, Running, Stuck, or No checks. The ticket's `pr` in `tickets.json` names the pull request, as a number read against the project's own repository or as a link T3's own parser reads. A ticket with no `pr` takes the link its agents' threads carry for the ticket's branch.

The state comes from three reads that the board merges, newest first. The engine pushes a snapshot of each linked pull request through the shell stream, but keeps it current only while a thread watches the pull request. `pullRequests.summary` and `pullRequests.checks` read the host, and every read carries the time the engine made it, so a saved answer the client paints first never beats a newer snapshot. The check list is read again every 45 seconds, and at once when a new snapshot arrives. A pull request that merged or closed stays so.

The host reports no start time for a check, so the board records when it first saw each check running, in local storage, and flags a check that has run longer than 20 minutes as **Stuck**. A check already running when the board first opened looks shorter than it is.

The peek drawer lists each check with its result and the six merge-ready conditions the XEO workflow sets, computed live by `domain/readiness.ts`:

| Condition                                      | Holds when                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI green on the head                           | the ticket has a pull request, it is not closed, every check passed or was skipped, none is stuck, and the checks ran on the ticket's `headSha` when the engine reports it |
| Independent reviews, introduced findings fixed | at least two roles gave a verdict, and each role's latest verdict has no P0 or P1                                                                                          |
| Fix-round delta re-reviewed                    | the ticket has no fix rounds, or a review role's thread has a `round` at or past `fixRounds`                                                                               |
| Touched READMEs pass                           | the ticket's evidence folder holds a file whose name has `readme-check`, `readme-pass`, or `readme-lint`                                                                   |
| Parent merged or ready                         | every `dependsOn` ticket is `merged`, or is `awaiting_approval` and the orchestrator's merge approval carries a note on the merge order                                    |
| Smoke evidence named                           | the ticket's evidence folder holds a file whose name has `smoke`                                                                                                           |

A merge approval card shows the same six, each with the orchestrator's claim from `foryou.jsonl` beside the live result. When they differ, the row says so. The card finds its ticket by the `ticket` key of the item, or by a ticket key that stands alone in its title or id.

**Remove worktree** appears on a ticket in the Merged lane whose `worktreePath` is still a worktree of the project. It runs T3's `vcs.removeWorktree`, the delete the Cleanup page uses, behind the same confirm.

The chip marks `board:pr-event` when a pull request's live state changes and `board:pr-painted` after the commit that shows a new reading.

## Browser panel

The sidebar's **Browser** row shows a panel beside the board. It is the app's one right-side host, which `App.tsx` lays out as the grid's last column, and a drag handle or the arrow keys on its left edge set its width.

Inside Electron the panel holds the user's tabs. `electron/browserView.ts` gives each tab its own `WebContentsView` in a persistent `persist:agent-board-browser` session, shows only the active one, and places it over the rectangle the renderer reports with `board:browser-bounds`. Every message is decoded with a schema before it is used, a page can only navigate to http(s) URLs, and the session denies every permission request. `src/browser/tabs.ts` keeps the tab list in a reducer, and `openInPanel(url)` in `src/browser/panel.ts` is the one entry point that opens a link in a new tab. A link in a markdown document, such as an artifact, goes through it. Without Electron, as in `dev:web`, it opens the system browser instead.

The **Agents** button lists the browser tabs the open board's orchestrator and agents hold in the engine. It reads `preview.list` for each thread of the board's family, reads it again when `subscribePreviewEvents` reports a change, and shows the tab you pick through the engine's `/api/preview-stream/ws` stream, authorized by a media ticket from `resolveDeviceHubAccess`. The view is watch-only. The engine keeps an agent's tabs whether or not the board is open, so they are there when the panel first opens.

Pressing **Browser** marks `board:browser-click`, and the panel marks `board:browser-painted` after its first paint.

## Engine probe

`scripts/engine-probe.ts` checks ten engine behaviors the board depends on, each against a real Claude Code session, and writes the results to [docs/engine-findings.md](docs/engine-findings.md). It starts its own T3 engine in `/tmp/engine-probe/run-<id>/t3`, never touches `~/.t3`, and stops that engine and its provider sessions when it ends. It reads `~/.claude/settings.json` without changing it, and deletes the Claude Code project folders its scratch projects created. Build the engine once with `vp run --filter t3 build`, then run it from a checkout.

```sh
node apps/board/scripts/engine-probe.ts                  # all ten checks, rewrites docs/engine-findings.md
node apps/board/scripts/engine-probe.ts --checks B,C     # some checks; leaves the findings file alone
node apps/board/scripts/engine-probe.ts --findings out.md --run-dir /tmp/probe
```

Each check prints `PASS` or `FAIL` with its evidence lines and wall time. The exit code is 1 when any check fails. The probe uses the operator's Claude Code login and costs usage, so run it once per change.

## Settings

The gear in the sidebar footer opens a settings screen laid out like Orca's, with a category list on the left and the selected page on the right. The selector at the top picks All projects, which edits the engine's own defaults, or one project, which stores an override and marks each field Inherited or Overridden. Every field saves on blur through `server.updateSettings`, so T3 itself runs the result.

**Worktrees** edits the setup script that T3's `ProjectSetupScriptRunner` runs in a new worktree (the `runOnWorktreeCreate` action in `defaultProjectScripts`, stored per project in `projectSettingsOverrides`), the worktree location (`worktreesDirectory`, per machine), and branch naming (`branchNamingMode`, `branchNamePrefix`, `branchNameInstructions`).

**Cleanup** edits the automatic worktree cleanup rules (`storageCleanup` for All projects, `projectSettingsOverrides.<id>.worktreeCleanup` for a project, which is Inherit, Off, or Custom). **Delete now** runs `server.runStorageCleanup` and lists the latest `StorageCleanupReport`, which `server.getStorageCleanupReport` also pushes. A cleanup waits 60 seconds after a thread settles before it removes the worktree, even with settled retention at 0 days. **Delete a worktree** removes one worktree with `vcs.removeWorktree` after a confirm. The list comes from the thread shells, checked against `vcs.listRefs`, so a folder that is already gone is not offered.

## Tests

```sh
vp run --filter @agent-board/app typecheck
cd apps/board && vp test run
node --test apps/board/scripts/*.test.mjs
node --test apps/board/plugins/omp-kit/engine/
```

## Plan

The build plan is [docs/plan.md](docs/plan.md).
