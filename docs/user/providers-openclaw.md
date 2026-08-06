# OpenClaw

This guide covers the OpenClaw provider in T3 Code. OpenClaw is a personal AI
assistant gateway (openclaw.ai): one daemon owns your sessions, tools, and
model access, and every client talks to it over a WebSocket. T3 Code can run
its own isolated gateway for you or connect to a gateway you already run. See
[Install T3 Code](./install.md) for first-time setup.

## Install OpenClaw

Install the OpenClaw CLI with the installer from openclaw.ai or through npm:

```bash
npm i -g openclaw
```

Verify the install:

```bash
openclaw --version
```

## Onboard OpenClaw

Run the onboarding flow and install the gateway daemon:

```bash
openclaw onboard --install-daemon
```

Follow the prompts to pick your model provider and sign in. The daemon keeps
your sessions and tools available between T3 Code runs.

## Add OpenClaw In T3 Code

In Settings, add an OpenClaw provider:

```text
Display name: OpenClaw
Binary path: openclaw
Gateway URL: empty
Gateway token: empty
Launch arguments: empty
```

- `Binary path` — the `openclaw` command. Use a full path if `openclaw` is not
  on PATH.
- `Gateway URL` — leave empty to let T3 Code spawn its own gateway for this
  instance. Point it at a running gateway (for example
  `ws://127.0.0.1:18789`) to reuse one you already run.
- `Gateway token` — the shared-secret token for the gateway. Set it when you
  point at an existing gateway that authenticates clients.
- `Launch arguments` — extra CLI flags passed to `openclaw gateway` on start.

## How T3 Code Uses OpenClaw

By default T3 Code spawns one isolated gateway per provider instance with its
own state directory, so the gateway never touches your `~/.openclaw` or a
gateway you run yourself. Each T3 thread maps to one gateway session, and the
session key is the durable resume cursor, so threads survive restarts.

If you already run a gateway (for example after `openclaw onboard
--install-daemon`), set the Gateway URL and Gateway token in the provider
settings and T3 Code connects to that gateway instead of spawning one.

## Models

When you refresh the provider, T3 Code reads the OpenClaw model list. It calls
`models.list` on a configured gateway. Otherwise, it runs
`openclaw models list --json`. The picker shows models that OpenClaw marks as
available. This includes models in the configured allowed list and catalog
models from available integrations, such as an installed Claude CLI.

OpenClaw does not add a model to this list after you use it. Add or enable the
model in OpenClaw before you select it for an agent session. Custom models in
T3 Code also need gateway support before OpenClaw can run them.

## Sessions, Streaming, And Approvals

T3 Code supports:

- Sessions that resume across restarts.
- Streaming responses, including thinking text and tool lifecycles.
- Tool approval requests. Approve or deny them from the composer, and T3 Code
  sends the decision back to the gateway.

## What Is Not Supported

OpenClaw cannot roll back turns. Use T3 Code's checkpoint revert to restore
the workspace instead.

OpenClaw has no free-text user-input request, so T3 Code cannot answer
free-text prompts from the agent. Tool approvals are answered through the
approval flow above.

## Use Multiple OpenClaw Instances

Add more than one OpenClaw provider in Settings. Each instance runs (or
connects to) its own gateway and keeps its own sessions, so two instances can
use different model accounts or different gateways without sharing state.
