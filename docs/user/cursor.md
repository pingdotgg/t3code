# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- A Cursor API key in `CURSOR_API_KEY`. Provider-instance environment variables override the host
  environment in the same way as the other providers.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

The adapter currently uses the SDK's local-agent runtime so runs operate in the selected T3 Code
workspace. Cursor cloud agents need repository and cloud-environment configuration that T3 Code does
not expose yet.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool output, plans, and todo streaming;
- thread-scoped T3 Code MCP tools;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. Sending a new message
from a projected child starts a new Cursor agent rather than pretending to resume the task runtime.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes and explicit non-full-access sandbox policies enable it. Explicit approval policy
overrides also control Cursor Auto-review. Auto-review is not represented as an interactive T3 Code
approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay -- --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
