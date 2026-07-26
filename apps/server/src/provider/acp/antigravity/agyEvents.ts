/**
 * Pure translation layer for the Antigravity ACP bridge.
 *
 * Antigravity exposes no native agent protocol, so the bridge reconstructs an
 * ACP event stream from two independent sources that Antigravity *does*
 * document:
 *
 *   - **Hooks** (`PreToolUse` / `PostToolUse` / `Stop`) deliver the tool name,
 *     its arguments, a human-readable summary, and completion status.
 *   - **The trajectory transcript** (`transcript.jsonl`) delivers assistant
 *     text and real tool output, appended progressively while the turn runs.
 *
 * The two correlate exactly: a hook's `stepIdx` is the transcript record's
 * `step_index`. Neither source alone is sufficient — hooks never carry tool
 * output, and the transcript never carries tool arguments.
 *
 * Everything here is pure so it can be tested without spawning `agy`. IO lives
 * in `agyBridge.ts`.
 *
 * @module provider/acp/antigravity/agyEvents
 */

/** Tool-call lifecycle kinds understood by ACP clients. */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AgyHookEventName = "pre-tool-use" | "post-tool-use" | "stop";

export interface AgyToolCall {
  readonly name?: string;
  readonly args?: Record<string, unknown> | null;
}

/**
 * Documented Antigravity hook payload. Every event carries `conversationId`
 * and `transcriptPath`, which is what lets the bridge resume a trajectory and
 * locate its transcript without guessing.
 */
export interface AgyHookPayload {
  readonly conversationId?: string;
  readonly stepIdx?: number;
  readonly toolCall?: AgyToolCall | null;
  readonly error?: string;
  readonly modelName?: string;
  readonly transcriptPath?: string;
  readonly artifactDirectoryPath?: string;
  readonly workspacePaths?: ReadonlyArray<string>;
  readonly fullyIdle?: boolean;
  readonly terminationReason?: string;
  readonly executionNum?: number;
}

export interface AgyHookEvent {
  readonly event: AgyHookEventName | string;
  readonly payload: AgyHookPayload;
  /**
   * Contents of the tool's target file, captured by the hook process itself.
   *
   * This cannot be read by the bridge when it drains hook output: both hooks
   * for a fast edit land inside a single poll interval, by which point the
   * edit has already been written and "before" would read back as "after".
   * The hook runs synchronously within the tool lifecycle, so it is the only
   * place that observes the true pre-edit state.
   */
  readonly capturedFileText?: string | null;
}

/**
 * Antigravity tool names, mapped onto ACP kinds so clients can pick the right
 * affordance. Unknown tools degrade to `other` rather than being dropped.
 */
export function agyToolKind(name: string | undefined): AcpToolKind {
  switch (name) {
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "edit_file":
      return "edit";
    case "view_file":
    case "view_code_item":
    case "list_dir":
    case "read_url_content":
      return "read";
    case "grep_search":
    case "find_by_name":
    case "codebase_search":
    case "search_web":
      return "search";
    case "run_command":
    case "command_status":
      return "execute";
    case "delete_file":
      return "delete";
    default:
      if (name && name.startsWith("browser_")) {
        return "fetch";
      }
      return "other";
  }
}

/**
 * Stable identity for one tool call across its hook pair and its transcript
 * record. `stepIdx` is unique within a conversation and is echoed verbatim as
 * the transcript's `step_index`.
 */
export function agyToolCallId(conversationId: string | undefined, stepIdx: number): string {
  return `agy-${conversationId ?? "unknown"}-${stepIdx}`;
}

/**
 * Prefer Antigravity's own human-readable summary over the raw tool name.
 * `PostToolUse` enriches `args` with `toolSummary`/`toolAction`; `PreToolUse`
 * usually has neither, so the tool name is the fallback.
 */
export function agyToolTitle(toolCall: AgyToolCall | null | undefined): string {
  const args = toolCall?.args;
  const summary = typeof args?.["toolSummary"] === "string" ? args["toolSummary"].trim() : "";
  if (summary.length > 0) {
    return summary;
  }
  const action = typeof args?.["toolAction"] === "string" ? args["toolAction"].trim() : "";
  if (action.length > 0) {
    return action;
  }
  return toolCall?.name?.trim() || "Antigravity tool";
}

/**
 * File path a tool acts on, when it names one. Antigravity uses PascalCase
 * argument keys and is not consistent about which one carries the path.
 */
export function agyTargetPath(toolCall: AgyToolCall | null | undefined): string | undefined {
  const args = toolCall?.args;
  if (!args) {
    return undefined;
  }
  for (const key of ["TargetFile", "AbsolutePath", "FilePath", "Path", "DirectoryPath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Metadata echoed onto every emitted update for debugging and traceability. */
export function agyUpdateMeta(event: string, payload: AgyHookPayload): Record<string, unknown> {
  return {
    antigravity: {
      event,
      conversationId: payload.conversationId ?? null,
      stepIdx: payload.stepIdx ?? null,
      modelName: payload.modelName ?? null,
      transcriptPath: payload.transcriptPath ?? null,
      artifactDirectoryPath: payload.artifactDirectoryPath ?? null,
    },
  };
}

export interface AgyToolCallRecord {
  readonly toolCallId: string;
  readonly name: string | undefined;
  readonly kind: AcpToolKind;
  readonly targetPath: string | undefined;
  /** File contents captured at `PreToolUse`, used to build an edit diff. */
  readonly beforeText: string | undefined;
  /** Set by `PostToolUse`. Records are kept after completion so a transcript
   * record that lands in the same poll can still attach the tool's output. */
  completed: boolean;
}

/**
 * Mutable bookkeeping shared by the hook and transcript readers for one turn.
 */
export interface AgyTurnState {
  /**
   * Every tool call seen this turn, keyed by step index — completed ones
   * included. The two event sources are drained in the same pass, so a step
   * must stay addressable after its `PostToolUse` hook or its transcript
   * output would be dropped whenever both arrive within one poll.
   */
  readonly toolCalls: Map<number, AgyToolCallRecord>;
  /**
   * Terminal `tool_call_update`s held back until the transcript record with
   * that step's output has been streamed. `AcpSessionRuntime` drops its tool
   * state once a call completes, so output emitted afterwards would surface as
   * a second, never-completed item.
   */
  readonly pendingTerminal: Map<number, AgySessionUpdate>;
  /**
   * Steps whose transcript output has already been streamed. The transcript is
   * read once by byte offset, so a record consumed before its `PostToolUse`
   * hook appeared will never be revisited — without this the tool would render
   * as running until the turn ended.
   */
  readonly transcriptSeenSteps: Set<number>;
  conversationId: string | undefined;
  transcriptPath: string | undefined;
  /** Transcript file pinned for the turn; see `resolveTranscriptPath`. */
  resolvedTranscriptPath: string | undefined;
  /**
   * Whether records predating this turn have been discarded. Reading starts at
   * byte 0, which on a resumed conversation is the start of the whole history.
   */
  transcriptPrimed: boolean;
  /**
   * Whether this turn resumed an existing conversation. Only then can the
   * transcript already hold other turns' records at byte 0.
   */
  readonly resumedConversation: boolean;
  modelName: string | undefined;
}

export function makeAgyTurnState(conversationId?: string): AgyTurnState {
  return {
    toolCalls: new Map(),
    pendingTerminal: new Map(),
    transcriptSeenSteps: new Set(),
    conversationId,
    transcriptPath: undefined,
    resolvedTranscriptPath: undefined,
    transcriptPrimed: false,
    resumedConversation: conversationId !== undefined,
    modelName: undefined,
  };
}

/** A `session/update` payload, shaped for ACP but kept as plain JSON. */
export type AgySessionUpdate = Record<string, unknown>;

/**
 * Translate one `PreToolUse` hook into an ACP `tool_call` announcement.
 *
 * `beforeText` is threaded in by the caller (which does the file read) so this
 * function stays pure.
 */
export function preToolUseUpdate(
  payload: AgyHookPayload,
  state: AgyTurnState,
  beforeText?: string,
): AgySessionUpdate | null {
  const stepIdx = payload.stepIdx;
  if (typeof stepIdx !== "number") {
    return null;
  }
  const toolCall = payload.toolCall;
  // Antigravity emits hook pairs for internal planner steps with no tool
  // attached. Those are not tool calls and must not render as one.
  if (!toolCall || !toolCall.name) {
    return null;
  }

  const toolCallId = agyToolCallId(payload.conversationId, stepIdx);
  const kind = agyToolKind(toolCall.name);
  const targetPath = agyTargetPath(toolCall);
  state.toolCalls.set(stepIdx, {
    toolCallId,
    name: toolCall.name,
    kind,
    targetPath,
    beforeText,
    completed: false,
  });

  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: agyToolTitle(toolCall),
    kind,
    status: "in_progress",
    rawInput: toolCall.args ?? null,
    ...(targetPath ? { locations: [{ path: targetPath }] } : {}),
    _meta: agyUpdateMeta("pre-tool-use", payload),
  };
}

/**
 * Translate one `PostToolUse` hook into an ACP `tool_call_update`.
 *
 * `afterText` is the on-disk content of an edited file, read by the caller
 * after the tool ran. Diffing captured before/after content sidesteps having
 * to interpret Antigravity's edit arguments, whose semantics vary by tool.
 */
export function postToolUseUpdate(
  payload: AgyHookPayload,
  state: AgyTurnState,
  afterText?: string,
): AgySessionUpdate | null {
  const stepIdx = payload.stepIdx;
  if (typeof stepIdx !== "number") {
    return null;
  }
  const active = state.toolCalls.get(stepIdx);
  // Only complete calls whose `PreToolUse` we actually observed; Antigravity
  // emits unpaired post hooks for internal steps.
  if (!active || active.completed) {
    return null;
  }
  // Marked rather than removed: the transcript record carrying this step's
  // output is often read in the same drain pass, and dropping the entry here
  // would leave it with no tool call to attach to.
  active.completed = true;

  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  const failed = error.length > 0;

  const content: Array<Record<string, unknown>> = [];
  if (
    !failed &&
    active.kind === "edit" &&
    active.targetPath &&
    afterText !== undefined &&
    afterText !== active.beforeText
  ) {
    content.push({
      type: "diff",
      path: active.targetPath,
      ...(active.beforeText === undefined ? {} : { oldText: active.beforeText }),
      newText: afterText,
    });
  }

  return {
    sessionUpdate: "tool_call_update",
    toolCallId: active.toolCallId,
    status: failed ? "failed" : "completed",
    ...(content.length > 0 ? { content } : {}),
    rawOutput: failed ? { isError: true, error } : { isError: false },
    _meta: agyUpdateMeta("post-tool-use", payload),
  };
}

/**
 * Fold a hook event into turn state, returning the update to emit (if any).
 *
 * `Stop` carries no user-visible update; it exists to publish the conversation
 * id that lets the next turn resume the same trajectory.
 */
export function hookSessionUpdate(
  hook: AgyHookEvent,
  state: AgyTurnState,
  fileText?: string,
): AgySessionUpdate | null {
  const payload = hook.payload ?? {};
  // Every hook carries the conversation id, so the bridge learns it from the
  // first event of the turn rather than waiting for `Stop`.
  const conversationId = payload.conversationId?.trim();
  if (conversationId) {
    state.conversationId = conversationId;
  }
  const transcriptPath = payload.transcriptPath?.trim();
  if (transcriptPath) {
    state.transcriptPath = transcriptPath;
  }
  const modelName = payload.modelName?.trim();
  if (modelName) {
    state.modelName = modelName;
  }

  switch (hook.event) {
    case "pre-tool-use":
      return preToolUseUpdate(payload, state, fileText);
    case "post-tool-use":
      return postToolUseUpdate(payload, state, fileText);
    default:
      return null;
  }
}

/**
 * Response Antigravity requires on stdout for each hook event.
 *
 * `pre-tool-use` must return a decision. When no bridge observer is attached
 * the safe answer is `ask`: a hook that silently allowed every tool outside a
 * managed turn would be a permission bypass.
 */
export interface AgyHookDecision {
  readonly decision: "allow" | "deny" | "ask";
  readonly reason?: string;
}

/**
 * Translate the client's `session/request_permission` reply into the decision
 * the blocked `PreToolUse` hook will print.
 *
 * Fails closed: only an explicit selection of the approve option allows the
 * tool. A cancelled prompt, an unknown option id, or a malformed reply all
 * deny, because this is the only thing standing between the model and a tool
 * that `agy` has already been told to run without asking.
 */
export function approvalOutcomeToDecision(
  result: unknown,
  approveOptionIds: ReadonlyArray<string>,
): AgyHookDecision {
  const outcome =
    typeof result === "object" && result !== null
      ? (result as { outcome?: unknown }).outcome
      : undefined;
  const selected =
    typeof outcome === "object" && outcome !== null
      ? (outcome as { outcome?: unknown; optionId?: unknown })
      : undefined;
  if (
    selected?.outcome === "selected" &&
    typeof selected.optionId === "string" &&
    approveOptionIds.includes(selected.optionId)
  ) {
    return { decision: "allow" };
  }
  return { decision: "deny", reason: "Rejected in T3 Code" };
}

export function agyHookResponse(event: string, observerAttached: boolean): Record<string, unknown> {
  switch (event) {
    case "pre-tool-use":
      return observerAttached
        ? { decision: "allow" }
        : {
            decision: "ask",
            reason: "T3 Code hook observer is not attached to a managed Antigravity turn",
          };
    // Antigravity's Stop contract requires a decision; anything other than
    // "continue" lets the completed execution stop.
    case "stop":
      return { decision: "stop" };
    default:
      return {};
  }
}
