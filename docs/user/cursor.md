# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- Sign in with Cursor in **Settings > Providers > Cursor**, or provide a Cursor API key in
  `CURSOR_API_KEY`.
- A paid Cursor plan on the account used for browser sign-in or `CURSOR_API_KEY`.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

The adapter currently uses the SDK's local-agent runtime so runs operate in the selected T3 Code
workspace. Cursor cloud agents need repository and cloud-environment configuration that T3 Code does
not expose yet.

## Sign in

Choose **Sign in**, then open the sign-in page and complete it in your browser. T3 Code
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Providers** for an already configured Cursor instance.

Each provider instance keeps its own login on the environment that runs it. Your Cursor editor and
CLI login are separate. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped T3 Code MCP tools;
- image attachments;
- interruption, queued app messages, and in-turn steering through the Agent SDK's `Run.steer`;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, or interactive
approval callbacks. A steer injects into the live run with `Run.steer` and leaves that run in place.
When the SDK declines the injection, the same message is sent as the next turn after this run
finishes. A provider or runtime change that has to apply immediately still interrupt-and-restarts.
Same-provider Cursor forks use the orchestrator's portable full-thread context handoff into a fresh
Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter intentionally uses the
authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes normally enable it. On Windows, Auto and Supervised run without filesystem
isolation when Cursor Auto-review is enabled, because the SDK does not support a filesystem sandbox
there. Restricted modes without Auto-review, including the default Auto-accept edits mode, still
request the sandbox and cannot start on Windows. Explicit sandbox policies remain authoritative,
including restrictive policies that the Windows SDK rejects. Explicit approval policy overrides
control Auto-review, which is not represented as an interactive T3 Code approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
