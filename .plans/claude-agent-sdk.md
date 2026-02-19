# Plan: Claude Code Integration via Agent SDK

## Context

T3 Code currently wraps Codex via `codex app-server` (JSON-RPC over stdio). This plan adds Claude Code as a second provider using `@anthropic-ai/claude-agent-sdk`, following lessons from reverse-engineering Conductor's integration.

### What we learned from Conductor

Conductor uses `@anthropic-ai/claude-agent-sdk@0.2.32` to programmatically control Claude Code. Key patterns:

1. **The SDK spawns `claude` as a child process** with `--output-format stream-json --input-format stream-json`. Communication is bidirectional over stdin/stdout using newline-delimited JSON.
2. **The SDK's `query()` function returns an async iterable** that yields typed messages (result, assistant, user, tool_use, etc.). It also exposes control methods: `interrupt()`, `setModel()`, `setPermissionMode()`, `setMaxThinkingTokens()`.
3. **Multi-turn works via an async generator** — you pass an `AsyncIterable` of user messages as the prompt. The SDK keeps the Claude Code process alive and feeds messages through as the generator yields them.
4. **Permission enforcement** uses a `canUseTool` callback that the SDK calls before Claude executes any tool. You return `{ behavior: "allow" }` or `{ behavior: "deny", message: "..." }`.
5. **Session resume** uses `--resume <sessionId>` to continue a previous Claude Code session.
6. **Hooks** (`UserPromptSubmit`, `Stop`, `PostToolUse`) enable checkpointing and lifecycle notifications.

### How T3 Code's current architecture maps

| Concept | Codex (current) | Claude Code (planned) |
|---|---|---|
| Process spawning | `spawn("codex", ["app-server"])` | Agent SDK's `query()` spawns `claude` internally |
| Protocol | JSON-RPC over stdio (request/response + notifications) | Stream-JSON over stdio (async iterable + control requests) |
| Session manager | `CodexAppServerManager` (manages sessions, turns, requests) | New `ClaudeCodeManager` (manages sessions, multi-turn generator, permissions) |
| Turn lifecycle | `thread/start` → `turn/start` → notifications → `turn/completed` | `query()` → iterate messages → result message = turn done |
| Approval flow | Server request → pending approval → `respondToRequest()` | `canUseTool` callback → return allow/deny |
| Thread resume | `thread/resume` with `threadId` | `--resume <claudeSessionId>` |
| Interrupt | `turn/interrupt` JSON-RPC | `query.interrupt()` control method |
| Checkpoints | `FilesystemCheckpointStore` (git-based, per-turn capture on `turn/completed`) | Same `FilesystemCheckpointStore`, trigger on SDK hooks instead |

---

## Phase 1: Contracts — Extend the provider abstraction

### 1a. Add Claude Code model options

**File: `packages/contracts/src/model.ts`**

Add Claude models alongside the existing Codex models. The model system needs to become provider-aware.

```ts
export const CLAUDE_MODEL_OPTIONS = [
  { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { slug: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
] as const;
```

Add a `resolveClaudeModelSlug()` function parallel to the existing `resolveModelSlug()`.

### 1b. Extend provider session start input

**File: `packages/contracts/src/provider.ts`**

The existing `providerSessionStartInputSchema` already has `provider: providerKindSchema` which includes `"claudeCode"`. Extend the start input to accept Claude-specific options:

```ts
export const providerSessionStartInputSchema = z.object({
  provider: providerKindSchema.default("codex"),
  cwd: z.string().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  // Codex-specific
  resumeThreadId: z.string().trim().min(1).optional(),
  codexBinaryPath: z.string().trim().min(1).optional(),
  codexHomePath: z.string().trim().min(1).optional(),
  approvalPolicy: providerApprovalPolicySchema.default("never"),
  sandboxMode: providerSandboxModeSchema.default("workspace-write"),
  // Claude-specific
  claudeSessionId: z.string().trim().min(1).optional(),
  claudeBinaryPath: z.string().trim().min(1).optional(),
  permissionMode: z.enum(["default", "plan", "bypassPermissions"]).optional(),
  maxThinkingTokens: z.number().int().min(0).optional(),
});
```

### 1c. Add Claude-specific event methods

The existing `ProviderEvent` schema is generic enough (it has `method`, `payload`, `textDelta`, etc.). Define the Claude event method strings we'll emit:

- `session/connecting`, `session/ready`, `session/closed`, `session/exited` (reuse existing Codex lifecycle)
- `assistant/text` — streaming text from Claude (maps to `textDelta`)
- `assistant/thinking` — extended thinking content
- `tool_use/start`, `tool_use/result` — tool call lifecycle
- `turn/completed` — a result message was received
- `permission/request` — Claude is asking for tool permission (maps to existing `request` kind)

No schema changes needed — the existing `ProviderEvent` shape handles all of this.

---

## Phase 2: Server — Build `ClaudeCodeManager`

### 2a. Install the SDK

```bash
cd apps/server && bun add @anthropic-ai/claude-agent-sdk
```

### 2b. Create `apps/server/src/claudeCodeManager.ts`

This is the core new file. It mirrors `CodexAppServerManager` but uses the Agent SDK instead of raw JSON-RPC.

**Key design:**

```ts
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

interface ClaudeSessionContext {
  session: ProviderSession;
  query: AsyncIterable & { interrupt, setModel, setPermissionMode, ... };
  sendMessage: ((message: string) => void) | null;
  sendTerminate: (() => void) | null;
  abortController: AbortController;
  currentModel: string | undefined;
}

export class ClaudeCodeManager extends EventEmitter<ClaudeCodeManagerEvents> {
  private sessions = new Map<string, ClaudeSessionContext>();
```

**Session lifecycle:**

```
startSession(input)
  1. Resolve claude binary path (bundled or system `claude`)
  2. Validate claude is available: execSync(`claude -v`)
  3. Create AbortController
  4. Set up async generator for multi-turn messages
  5. Call claudeQuery({ prompt: asyncGenerator, options: { ... } })
  6. Start consuming the async iterable in background, emitting ProviderEvents
  7. Return ProviderSession with status "ready"

sendTurn(input)
  1. Look up session
  2. Push message into the async generator's queue
  3. Return { threadId, turnId } — generate turnId locally since Claude Code
     doesn't have an explicit turn/start like Codex

interruptTurn(input)
  1. Call query.interrupt()

stopSession(input)
  1. Call sendTerminate() to break the async generator
  2. Abort the controller
  3. Clean up maps
```

### 2c. Multi-turn message queue pattern

Directly from Conductor — this is the proven pattern:

```ts
function createMessageQueue() {
  const queue: string[] = [];
  let waiter: ((msg: string) => void) | null = null;
  let terminated = false;

  const push = (msg: string) => {
    queue.push(msg);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(queue.shift()!);
    }
  };

  const terminate = () => {
    terminated = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve("");
    }
  };

  async function* generator() {
    while (!terminated) {
      const msg = queue.shift() ?? await new Promise<string>(r => { waiter = r; });
      if (terminated) break;
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: msg },
        session_id: "",
        parent_tool_use_id: null,
      };
    }
  }

  return { push, terminate, generator: generator() };
}
```

### 2d. Map SDK messages to ProviderEvent

The SDK yields messages with a `type` field. Map them to the existing event schema:

```ts
for await (const message of query) {
  switch (message.type) {
    case "assistant":
      // Emit with method "assistant/message", payload = full message
      // Extract text content blocks, emit textDelta for streaming
      break;
    case "result":
      // Emit "turn/completed" — this marks the end of a turn
      // Update session status to "ready"
      break;
    case "tool_use":
      // Emit "tool_use/start" with tool name and input
      break;
    case "tool_result":
      // Emit "tool_use/result"
      break;
    // ... etc
  }
}
```

### 2e. Permission handling via `canUseTool`

Map the SDK's `canUseTool` callback to the existing approval request flow:

```ts
const canUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal }
) => {
  // In "full access" mode (approvalPolicy: "never"), auto-approve everything
  if (effectiveApprovalPolicy === "never") {
    return { behavior: "allow", updatedInput: input };
  }

  // In "supervised" mode, emit a permission request event and wait for response
  const requestId = randomUUID();
  this.emitEvent({
    kind: "request",
    method: `tool/${toolName}/requestApproval`,
    requestId,
    requestKind: isFileEditTool(toolName) ? "file-change" : "command",
    payload: { toolName, input },
    ...
  });

  // Wait for the frontend to call respondToRequest()
  const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
    pendingApprovals.set(requestId, { resolve });
  });

  if (decision === "accept" || decision === "acceptForSession") {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "User declined" };
};
```

### 2f. Checkpointing integration

Reuse the existing `FilesystemCheckpointStore`. Instead of triggering on `turn/completed` notifications, use SDK hooks:

```ts
const sdkOptions = {
  // ...
  hooks: {
    Stop: [{
      matcher: {},
      hooks: [async () => {
        // Capture filesystem checkpoint on turn end
        await checkpointStore.captureCheckpoint({ cwd, threadId, turnCount });
      }],
    }],
  },
};
```

Alternatively, keep the existing approach in `ProviderManager` where checkpoints are captured when `turn/completed` events are emitted — just make sure `ClaudeCodeManager` emits that event.

---

## Phase 3: Server — Wire into ProviderManager

### 3a. Add ClaudeCodeManager as a second backend

**File: `apps/server/src/providerManager.ts`**

```ts
import { ClaudeCodeManager } from "./claudeCodeManager";

export class ProviderManager extends EventEmitter<ProviderManagerEvents> {
  private readonly codex = new CodexAppServerManager();
  private readonly claude = new ClaudeCodeManager();

  constructor() {
    super();
    this.codex.on("event", this.onProviderEvent);
    this.claude.on("event", this.onProviderEvent);
  }
```

### 3b. Route by provider kind

Every method in `ProviderManager` currently assumes Codex. Add provider routing:

```ts
async startSession(raw: ProviderSessionStartInput): Promise<ProviderSession> {
  const input = providerSessionStartInputSchema.parse(raw);

  if (input.provider === "claudeCode") {
    const session = await this.claude.startSession(input);
    // Initialize checkpointing same as Codex
    return session;
  }

  // Existing Codex path
  const session = await this.codex.startSession(input);
  // ...
}
```

Apply the same pattern to `sendTurn`, `interruptTurn`, `respondToRequest`, `stopSession`, `listSessions`.

### 3c. Unified session lookup

Add a helper to find which backend owns a session:

```ts
private resolveBackend(sessionId: string): "codex" | "claudeCode" {
  if (this.codex.hasSession(sessionId)) return "codex";
  if (this.claude.hasSession(sessionId)) return "claudeCode";
  throw new Error(`Unknown provider session: ${sessionId}`);
}
```

### 3d. Checkpoint/revert for Claude

Claude Code sessions don't have Codex's `thread/read` and `thread/rollback` APIs. Two approaches:

**Option A (recommended): Filesystem-only revert.** The `FilesystemCheckpointStore` already handles git checkpoints independently. For Claude, revert the filesystem and start a new session with `--resume <sessionId> --resume-session-at <messageId>`. This is what Conductor does.

**Option B: Simpler — just filesystem revert without conversation rewind.** Revert the git state, but don't try to rewind the Claude conversation. The user can continue chatting and Claude will see the reverted files. Good enough for v1.

---

## Phase 4: Contracts & Web — Frontend support

### 4a. Provider picker

The web app needs to let users choose between Codex and Claude Code. The `providerKindSchema` already has `"claudeCode"` — wire it into the UI.

### 4b. Model selector

When `provider === "claudeCode"`, show Claude models instead of Codex models.

### 4c. Event rendering

The existing event rendering in the web app is Codex-shaped (agentMessage delta, tool calls, etc.). Claude events will have different shapes. Add a renderer branch:

- Claude text streaming → render as assistant message (same UI as Codex `agentMessage/delta`)
- Claude tool_use → render as tool call (same UI as Codex command execution)
- Claude permission request → render approval dialog (reuse existing Codex approval UI)

### 4d. Permission mode toggle

Add a toggle for Claude's `permissionMode` (maps to the existing "Full access" / "Supervised" toggle, but using Claude's native permission system).

---

## Phase 5: Session resume

### 5a. Track Claude session IDs

When a Claude session starts, the SDK returns a `sessionId` in the initialization result. Store this in the `ProviderSession.threadId` field (or a new `claudeSessionId` field).

### 5b. Resume on reconnect

When the user reopens a thread, pass `claudeSessionId` to `startSession` which passes it as `resume` to the SDK. Claude Code will resume the conversation.

---

## Implementation order

1. **Contracts changes** (1a, 1b, 1c) — ~30 min. Low risk.
2. **`ClaudeCodeManager` core** (2a-2d) — the bulk of the work. Start with basic single-turn, then add multi-turn.
3. **ProviderManager routing** (3a-3c) — mechanical wiring.
4. **Manual testing** — start a Claude session via the existing web UI with `provider: "claudeCode"`.
5. **Frontend changes** (4a-4d) — provider picker, model selector, event rendering.
6. **Checkpointing** (2f, 3d) — wire in after basic flow works.
7. **Session resume** (5a, 5b) — last, since it requires stable session IDs.

---

## Key SDK API reference

From the SDK (`@anthropic-ai/claude-agent-sdk`):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "Fix the bug" | asyncIterable,
  options: {
    cwd: "/path/to/project",
    model: "sonnet",
    pathToClaudeCodeExecutable: "/path/to/claude",  // optional, defaults to system claude
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: "default",  // "default" | "plan" | "bypassPermissions"
    maxTurns: 1000,
    maxThinkingTokens: 10000,   // optional
    resume: "session-id",       // optional, resume existing session
    resumeSessionAt: "msg-id",  // optional, resume at specific message
    canUseTool: async (toolName, input, options) => ({ behavior: "allow" }),
    hooks: { ... },
    env: { ... },               // environment variables for the claude process
    additionalDirectories: [],  // extra directories claude can access
    disallowedTools: [],        // tools to block
    mcpServers: {},             // MCP servers to inject
    includePartialMessages: true, // for streaming
  },
});

// result is AsyncIterable<SdkMessage>
for await (const message of result) {
  // message.type: "assistant" | "user" | "result" | "tool_use" | "tool_result" | ...
}

// Control methods:
await result.interrupt();
await result.setModel("opus");
await result.setPermissionMode("plan");
await result.setMaxThinkingTokens(5000);
await result.accountInfo();           // { plan, email, ... }
await result.supportedCommands();     // slash commands
await result.mcpServerStatus();       // MCP server connection status
```

---

## Files to create/modify

| File | Action | Description |
|---|---|---|
| `packages/contracts/src/model.ts` | modify | Add Claude model options |
| `packages/contracts/src/provider.ts` | modify | Add Claude-specific session start fields |
| `apps/server/package.json` | modify | Add `@anthropic-ai/claude-agent-sdk` dependency |
| `apps/server/src/claudeCodeManager.ts` | **create** | Core Claude Code session manager |
| `apps/server/src/claudeCodeManager.test.ts` | **create** | Tests |
| `apps/server/src/providerManager.ts` | modify | Route to Claude backend based on provider kind |
| `apps/server/src/providerManager.test.ts` | modify | Add Claude routing tests |
| `apps/web/src/...` (chat UI) | modify | Provider picker, model selector, event rendering |

---

## Risks and mitigations

1. **SDK message format is not documented.** Mitigation: The Conductor analysis gives us the full message type catalog. Also, the SDK source is bundled as readable JS — we can inspect it.

2. **Claude Code binary must be installed.** Unlike Codex which is installed via npm, Claude Code is a separate install. For v1, require it on PATH. For the desktop app, we could bundle it like Conductor does.

3. **No explicit turn/thread abstraction.** Codex has `thread/start`, `turn/start`, etc. Claude Code just has a continuous conversation. We synthesize turn boundaries from the message stream (a `result` message = turn completed).

4. **Checkpoint revert is harder.** Codex has `thread/rollback`. Claude Code doesn't. Filesystem revert + session resume is the workaround (Conductor's approach).

5. **Streaming granularity differs.** Codex sends `item/agentMessage/delta` with text deltas. The Claude SDK yields full message objects. We may need to diff consecutive messages to extract deltas, or use `includePartialMessages: true` to get incremental updates.
