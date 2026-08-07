# Pi

This guide covers the Pi coding agent provider in T3 Code. Pi is an agent
CLI that runs in your terminal or through T3 Code. See [Install T3 Code](./install.md)
for first-time setup.

## Install Pi

Pi is distributed as an npm package:

```bash
npm i -g @earendil-works/pi-coding-agent
```

Verify the install:

```bash
pi --version
```

## Log In

Pi authenticates with your model providers directly. Run:

```bash
pi
```

and use Pi's `/login` command inside the agent, or configure provider API
keys in Pi's config directory (`~/.pi/agent` by default).

## Add Pi In T3 Code

In Settings, add a Pi provider:

```text
Display name: Pi
Binary path: pi
PI_CODING_AGENT_DIR path: empty
Launch arguments: empty
```

- `Binary path` — the `pi` command. Use a full path if `pi` is not on PATH.
- `PI_CODING_AGENT_DIR path` — where Pi keeps its config and sessions.
  Leave empty for the default `~/.pi/agent`.
- `Launch arguments` — extra CLI flags passed to `pi --mode rpc` on session
  start, for example `--no-auto-approve`.

## Use Multiple Pi Accounts

Pi keeps config and sessions in one directory. To run a second account with
its own login and session history, point a second Pi provider at a separate
directory:

```bash
mkdir -p ~/.pi_work
PI_CODING_AGENT_DIR=~/.pi_work pi
```

Log in inside that Pi, then add another Pi provider in T3 Code:

```text
Display name: Pi Work
PI_CODING_AGENT_DIR path: ~/.pi_work
```

Each provider instance keeps its own Pi process and session files, so the
two accounts never share state.

## Models

When you refresh the Pi provider, T3 Code starts Pi RPC mode and reads its
`get_available_models` catalog. The picker shows models available through the
provider accounts in that Pi directory. Pi model IDs include their provider,
for example `openrouter/deepseek/deepseek-v4-flash-0731`.

If the catalog check fails, T3 Code shows its fallback models and Custom
models. A catalog check failure does not stop a Pi session from starting.

## Model Switching

Pi switches models inside a running session. Pick a different model in the
model picker and the next turn uses it. The Reasoning option maps to Pi's
thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

## Pi Requests Permission

Pi has no built-in permission system. When a Pi extension asks you to
confirm or choose an option, T3 Code shows the request in the composer and
you can Allow or Deny it. Requests for free-text input are cancelled
automatically, because T3 Code has no free-text input flow.

## Roll Back A Turn

Pi cannot roll back turns. Use T3 Code's checkpoint revert to restore the
workspace; conversation history stays in Pi and you can branch from an
entry with Pi's `/tree` command.
