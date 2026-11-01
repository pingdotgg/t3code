import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

/**
 * Opts a session into fx's `libfx/hook` events (fx 0.0.14+), which report each
 * sub-agent's steps and the whole `subagent` result that ACP clips to 200
 * bytes. Capture is all-or-nothing, so unused events are dropped at decode.
 */
export const FX_HOOKS_SESSION_META = { fx: { hooks: { captureContent: true } } };

const FX_HOOK_METHOD = "libfx/hook";
const FX_SUBAGENT_TOOL = "subagent";
/** Where hook facts ride on a root `subagent` tool call, beside fx's own `_meta.fx`. */
const HOOK_STATE_META_KEY = "t3code/fxSubagentHooks";

const FxSubagentHookState = Schema.Struct({
  childSessionId: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.String),
  /** fx's whole `{ok, result}` reply from the root call's hooks, up to their 64 KiB cap. */
  output: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
});
type FxSubagentHookState = typeof FxSubagentHookState.Type;
const decodeHookStateMeta = Schema.decodeUnknownOption(
  Schema.Struct({ [HOOK_STATE_META_KEY]: FxSubagentHookState }),
);

const decodeHooksConfirmation = Schema.decodeUnknownOption(
  Schema.Struct({ fx: Schema.Struct({ hooksVersion: Schema.Literal(1) }) }),
);

const FxHookEvent = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  rootSessionId: Schema.String,
  executionId: Schema.String,
  type: Schema.String,
  data: Schema.Unknown,
  contentTruncated: Schema.Boolean,
});
type FxHookEvent = typeof FxHookEvent.Type;

const HookCall = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  argumentsJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeDelegation = Schema.decodeUnknownOption(
  Schema.Struct({ callId: Schema.String, childSessionId: Schema.String, phase: Schema.String }),
);
const decodeToolStart = Schema.decodeUnknownOption(Schema.Struct({ call: HookCall }));
const decodeToolOutcome = Schema.decodeUnknownOption(
  Schema.Struct({
    call: HookCall,
    output: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.String,
  }),
);
const decodeModelStart = Schema.decodeUnknownOption(
  Schema.Struct({ modelCallId: Schema.Number, purpose: Schema.String }),
);
const decodeModelEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    modelCallId: Schema.Number,
    output: Schema.optionalKey(Schema.NullOr(Schema.String)),
    toolCalls: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
);
const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const FxSubagentRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("run"),
    task: Schema.String,
    model: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("message"),
    agent: Schema.String,
    message: Schema.String,
    model: Schema.optionalKey(Schema.String),
  }),
]);
// fx 0.0.14 wraps the arguments in `request`; later fx sends them flat (vercel-labs/fx@df0878eb).
const decodeFxSubagentInput = Schema.decodeUnknownOption(
  Schema.Union([FxSubagentRequest, Schema.Struct({ request: FxSubagentRequest })]),
);
const decodeFxToolContent = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ content: Schema.Struct({ text: Schema.String }) })),
);
const decodeFxSubagentResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Boolean, result: Schema.NullOr(Schema.String) }),
  ),
);
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/**
 * fx clips ACP tool results to 199 bytes and hook content to 64 KiB, so a long
 * reply can arrive as cut-off `{"ok":…,"result":"…` JSON. Keeps the readable
 * prefix and marks the cut.
 */
function fxSubagentOutcome(
  text: string,
): { readonly ok: boolean; readonly result: string | null } | undefined {
  const whole = decodeFxSubagentResult(text);
  if (Option.isSome(whole)) return whole.value;
  const clipped = /^\{"ok":(true|false),"result":"((?:[^"\\]|\\.)*)/.exec(text);
  if (clipped === null) return undefined;
  const prefix = decodeJsonString(`"${(clipped[2] ?? "").replace(/\\u[0-9a-fA-F]{0,3}$/, "")}"`);
  const cut = text[clipped[0].length] !== '"';
  return {
    ok: clipped[1] === "true",
    result: Option.isSome(prefix) ? `${prefix.value}${cut ? "…" : ""}` : null,
  };
}

function fxSubagentReply(state: FxSubagentHookState & { readonly output: string }): string {
  const reply = fxSubagentOutcome(state.output)?.result ?? state.output;
  return state.truncated === true ? `${reply}\n\n[fx truncated this reply at 64 KiB]` : reply;
}

function hookedSubagentStatus(
  tool: AcpToolCallState,
  hooks: FxSubagentHookState,
): AcpAdapterV2SubagentUpdate["status"] {
  if (tool.status === "failed") return hooks.phase === "cancelled" ? "cancelled" : "failed";
  // fx completes the ACP call before it reports the whole result.
  if (hooks.output === undefined) return "running";
  if (hooks.phase === "yielded") return "idle";
  if (hooks.phase === "cancelled") return "cancelled";
  if (hooks.phase === "failed" || fxSubagentOutcome(hooks.output)?.ok === false) return "failed";
  return "completed";
}

/** Each `subagent` call becomes a child thread; with hooks it also gets the child's steps. */
export function extractFxSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== FX_SUBAGENT_TOOL) return undefined;
  const input = decodeFxSubagentInput(tool.data.rawInput);
  if (Option.isNone(input)) return undefined;
  const request = "request" in input.value ? input.value.request : input.value;
  const update = {
    nativeTaskId: tool.toolCallId,
    prompt: request.action === "run" ? request.task : request.message,
    title: request.action === "message" ? request.agent : null,
    model: request.model ?? null,
  };
  const hooks = Option.getOrUndefined(decodeHookStateMeta(tool.data.meta))?.[HOOK_STATE_META_KEY];
  const text = Option.getOrUndefined(decodeFxToolContent(tool.data.content))?.[0]?.content.text;
  const outcome = text === undefined ? undefined : fxSubagentOutcome(text);
  if (hooks !== undefined) {
    const status = hookedSubagentStatus(tool, hooks);
    return {
      ...update,
      childSessionId: hooks.childSessionId ?? null,
      status,
      result:
        status === "running"
          ? null
          : hooks.output === undefined
            ? (outcome?.result ?? text ?? null)
            : fxSubagentReply({ ...hooks, output: hooks.output }),
    };
  }
  const status =
    tool.status === "completed"
      ? outcome?.ok === false
        ? "failed"
        : "completed"
      : tool.status === "failed"
        ? "failed"
        : "running";
  return {
    ...update,
    childSessionId: null,
    status,
    result: status === "running" ? null : (outcome?.result ?? text ?? null),
  };
}

// Provisional: fx names the child behind a forwarded approval here in an
// unmerged PR, so a rename changes this schema alone.
const decodePermissionSubagent = Schema.decodeUnknownOption(
  Schema.Struct({ fx: Schema.Struct({ subagent: Schema.Struct({ sessionId: Schema.String }) }) }),
);

/** The child session behind a sub-agent's approval, which fx asks and takes answers for on the parent. */
export function fxPermissionSubagentSessionId(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return Option.getOrUndefined(decodePermissionSubagent(request._meta))?.fx.subagent.sessionId;
}

/** fx's own `tool_call` kinds (src/acp/tool_call_presentation.zig). */
function fxToolKind(name: string): EffectAcpSchema.ToolKind {
  switch (name) {
    case "read_file":
    case "glob_files":
      return "read";
    case "grep_files":
    case "web_search":
      return "search";
    case "web_fetch":
      return "fetch";
    case "write_file":
    case "edit_file":
      return "edit";
    case "shell":
    case "terminal":
    case "run_command":
      return "execute";
    default:
      return "other";
  }
}

/** Every update names the call in full; one without a title presents as a bare "Tool". */
function childToolCall(call: typeof HookCall.Type) {
  const rawInput = Option.getOrUndefined(decodeArguments(call.argumentsJson));
  return {
    toolCallId: call.callId,
    name: call.name,
    title: call.name,
    kind: fxToolKind(call.name),
    ...(rawInput === undefined ? {} : { rawInput }),
  };
}

const textContent = (text: string | null | undefined) =>
  text ? [{ type: "content" as const, content: { type: "text" as const, text } }] : [];

interface RootSubagentCall {
  readonly sessionId: string;
  /** fx's ACP `tool_call` arrived, so a hook-made update cannot invent a tool. */
  announced: boolean;
  state: FxSubagentHookState;
}

/**
 * Turns fx hook events into ACP updates the adapter already projects: facts
 * about a root `subagent` call ride on that call's `_meta`, and a dispatched
 * child's steps arrive as updates on the child's session. A child is followed
 * only while its call runs, the only time a turn can take its steps.
 */
export function makeFxSubagentHookRouter() {
  const calls = new Map<string, RootSubagentCall>();
  const childCalls = new Map<string, string>();
  const agentModelCalls = new Set<string>();

  const rootUpdate = (
    callId: string,
    call: RootSubagentCall,
  ): ReadonlyArray<EffectAcpSchema.SessionNotification> =>
    call.announced
      ? [
          {
            sessionId: call.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: callId,
              _meta: { [HOOK_STATE_META_KEY]: call.state },
            },
          },
        ]
      : [];

  const routeRoot = (event: FxHookEvent): ReadonlyArray<EffectAcpSchema.SessionNotification> => {
    if (event.type === "delegation") {
      const delegation = Option.getOrUndefined(decodeDelegation(event.data));
      if (delegation === undefined) return [];
      let call = calls.get(delegation.callId);
      if (call === undefined) {
        call = { sessionId: event.sessionId, announced: false, state: {} };
        calls.set(delegation.callId, call);
      }
      if (delegation.phase === "dispatched") {
        call.state = { ...call.state, childSessionId: delegation.childSessionId };
        childCalls.set(delegation.childSessionId, delegation.callId);
      } else if (childCalls.get(delegation.childSessionId) === delegation.callId) {
        childCalls.delete(delegation.childSessionId);
      }
      call.state = { ...call.state, phase: delegation.phase };
      return rootUpdate(delegation.callId, call);
    }
    // A parallel batch holds every `tool.result` until its slowest call; `tool.end` comes at once.
    if (event.type !== "tool.end" && event.type !== "tool.result") return [];
    const result = Option.getOrUndefined(decodeToolOutcome(event.data));
    const call = result === undefined ? undefined : calls.get(result.call.callId);
    const output = result?.output;
    if (result === undefined || call === undefined || output === undefined || output === null) {
      return [];
    }
    calls.delete(result.call.callId);
    call.state = { ...call.state, output, truncated: event.contentTruncated };
    const { childSessionId, phase } = call.state;
    if (childSessionId !== undefined) childCalls.delete(childSessionId);
    const reply = fxSubagentReply({ ...call.state, output });
    return [
      // The reply goes in before the call settles, so the child thread ends on it.
      ...(childSessionId === undefined || phase === "yielded" || reply.length === 0
        ? []
        : [
            {
              sessionId: childSessionId,
              update: {
                sessionUpdate: "agent_message" as const,
                messageId: "result",
                content: [{ type: "text" as const, text: reply }],
              },
            },
          ]),
      ...rootUpdate(result.call.callId, call),
    ];
  };

  const routeChild = (event: FxHookEvent): ReadonlyArray<EffectAcpSchema.SessionNotification> => {
    const sessionId = event.sessionId;
    switch (event.type) {
      case "tool.start": {
        const start = Option.getOrUndefined(decodeToolStart(event.data));
        if (start === undefined) return [];
        return [
          {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              ...childToolCall(start.call),
              status: "in_progress",
            },
          },
        ];
      }
      case "tool.end":
      case "tool.result": {
        const outcome = Option.getOrUndefined(decodeToolOutcome(event.data));
        if (outcome === undefined) return [];
        return [
          {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              ...childToolCall(outcome.call),
              status: outcome.status === "success" ? "completed" : "failed",
              content: textContent(outcome.output),
            },
          },
        ];
      }
      case "model.start": {
        const start = Option.getOrUndefined(decodeModelStart(event.data));
        // Review, compaction and title calls are fx's own, not the child speaking.
        if (start?.purpose === "agent") {
          agentModelCalls.add(`${sessionId}:${event.executionId}:${start.modelCallId}`);
        }
        return [];
      }
      case "model.end": {
        const end = Option.getOrUndefined(decodeModelEnd(event.data));
        if (
          end === undefined ||
          !agentModelCalls.delete(`${sessionId}:${event.executionId}:${end.modelCallId}`)
        )
          return [];
        // A reply without tool calls is the child's answer, which the root result carries whole.
        if (!end.output?.trim() || (end.toolCalls?.length ?? 0) === 0) return [];
        return [
          {
            sessionId,
            update: {
              sessionUpdate: "agent_message",
              messageId: `${event.executionId}:${end.modelCallId}`,
              content: [{ type: "text", text: end.output }],
            },
          },
        ];
      }
      default:
        return [];
    }
  };

  return {
    reset: () => {
      calls.clear();
      childCalls.clear();
      agentModelCalls.clear();
    },
    /** Records fx's `subagent` calls and attaches what hooks reported so far. */
    enrich: (
      notification: EffectAcpSchema.SessionNotification,
    ): EffectAcpSchema.SessionNotification => {
      const update = notification.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return notification;
      }
      let call = calls.get(update.toolCallId);
      if (call === undefined) {
        if (update.sessionUpdate !== "tool_call" || update.name !== FX_SUBAGENT_TOOL) {
          return notification;
        }
        call = { sessionId: notification.sessionId, announced: true, state: {} };
        calls.set(update.toolCallId, call);
      }
      call.announced = true;
      return {
        ...notification,
        update: { ...update, _meta: { ...update._meta, [HOOK_STATE_META_KEY]: call.state } },
      };
    },
    route: (event: FxHookEvent): ReadonlyArray<EffectAcpSchema.SessionNotification> => {
      if (event.sessionId === event.rootSessionId) return routeRoot(event);
      // Grandchildren stay inside their parent's `subagent` step.
      return childCalls.has(event.sessionId) ? routeChild(event) : [];
    },
  };
}

type SessionUpdateHandler = Parameters<
  AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]
>[0];

/**
 * Routes fx's hook events through the adapter's session update handlers. A
 * session fx does not confirm hooks for (fx 0.0.13) keeps the ACP-only view.
 */
export function withFxSubagentHooks(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const router = makeFxSubagentHookRouter();
  const handlers: Array<SessionUpdateHandler> = [];
  let hooksActive = false;
  const activated = <E, R>(
    effect: Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeStartResult, E, R>,
  ) =>
    Effect.sync(() => {
      hooksActive = false;
      router.reset();
    }).pipe(
      Effect.andThen(effect),
      Effect.tap((result) =>
        Effect.sync(() => {
          hooksActive = Option.isSome(decodeHooksConfirmation(result.sessionSetupResult._meta));
        }),
      ),
    );
  return {
    ...runtime,
    start: () => activated(runtime.start()),
    loadSession: (sessionId, options) => activated(runtime.loadSession(sessionId, options)),
    resumeSession: (sessionId, options) => activated(runtime.resumeSession(sessionId, options)),
    forkSession: (sessionId, options) => activated(runtime.forkSession(sessionId, options)),
    handleSessionUpdate: Effect.fn("FxSubagentHooks.handleSessionUpdate")(function* (
      handler: SessionUpdateHandler,
    ) {
      if (handlers.length === 0) {
        yield* runtime.handleExtNotification(FX_HOOK_METHOD, FxHookEvent, (event) =>
          hooksActive
            ? Effect.forEach(
                router.route(event),
                (notification) =>
                  Effect.forEach(handlers, (each) => each(notification), { discard: true }),
                { discard: true },
              )
            : Effect.void,
        );
      }
      handlers.push(handler);
      yield* runtime.handleSessionUpdate((notification) =>
        handler(hooksActive ? router.enrich(notification) : notification),
      );
    }),
  };
}
