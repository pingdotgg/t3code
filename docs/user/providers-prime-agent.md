# Prime Agent

KBCode runs [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (`prime-agent`) over the
Agent Client Protocol (ACP) in your repository or worktree directory, supporting Recursive Language
Models (`rlm.spawn`), persistent IPython REPL execution, and continual harness workflows.

## Set Up Prime Agent

1. Install the Prime Agent CLI on the machine hosting your KBCode server (macOS or Linux; use WSL
   or Git Bash on Windows):
   ```bash
   curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
   ```
2. Sign in by running `prime-agent` and `/login`, or set `PRIME_API_KEY` (or your upstream model
   provider API key) in **Settings → Providers → Prime Agent**.
3. Open **Settings → Providers**, enable **Prime Agent**, and refresh its status.

If `prime-agent` is not on the server's `PATH`, set **Binary path** in provider settings.

## Models, Thinking, and Mid-Thread Changes

Prime Agent binds `--provider`, `--model`, `--thinking`, `RLM_MAX_DEPTH`, and autonomous budget
caps at process startup. Changing any of those options in the composer model menu cleanly restarts
the `prime-agent` child process with the new flags and reattaches to the same conversation via
`--resume <session_id>`.

## Recursive Depth (`RLM_MAX_DEPTH`)

`RLM_MAX_DEPTH` defaults to `2`. You can change the default in **Settings → Providers → Prime
Agent** or override it per thread in the model menu (**RLM depth**). Set it to `0` to disable
recursive `rlm.spawn(...)` subagent spawning.

## Slash Commands and Budgets

Prime Agent exposes `/goal`, `/autonomous`, and `/refine` in the `/` command menu and in the
composer's **Prime** quick-controls popover:

- `/goal`: keep a multi-turn objective active until completed, paused, or cleared.
- `/autonomous`: run a bounded autonomous loop with configurable `--max-turns` and `--max-tokens`
  budget caps.
- `/refine`: review the session trajectory and apply incremental Continual Harness updates.

## Local Host vs. Cloud Sandbox Isolation

Because Prime Agent executes Python/IPython REPL code and spawns recursive subagents, KBCode shows
a warning banner whenever Prime Agent targets a non-cloud local host. Run Prime Agent inside a
cloud sandbox environment (or set **RLM depth** to `0`) when stricter isolation is needed.
