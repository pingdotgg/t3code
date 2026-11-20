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

## Tests

```sh
vp run --filter @agent-board/app typecheck
cd apps/board && vp test run
node --test apps/board/scripts/*.test.mjs
node --test apps/board/plugins/omp-kit/engine/
```

## Plan

The build plan is [docs/plan.md](docs/plan.md).
