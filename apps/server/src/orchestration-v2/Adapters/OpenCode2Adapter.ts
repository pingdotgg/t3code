import type {
  OpenCodeClient,
  OpenCodeEvent,
  SessionMessageAssistant,
  SessionInfo,
  PermissionRequest,
  FormInfo,
  SessionMessageAssistantTool,
} from "@opencode/client";
import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  OrchestrationV2ExecutionNode,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Native from "../../provider/OpenCode2Client.ts";
import * as Forms from "../../provider/OpenCode2Forms.ts";
import type { OpenCodeRuntimeError } from "../../provider/opencodeRuntime.ts";
import { parseOpenCodeModelSlug, toOpenCodeFileParts } from "../../provider/opencodeRuntime.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { providerMessageTextWithAttachmentPaths } from "../AttachmentPrompt.ts";
import type { ServerConfig } from "../../config.ts";
import type { IdAllocatorV2 } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  ProviderAdapterV2,
  ProviderAdapterProtocolError,
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { OPENCODE_PROVIDER, OpenCodeProviderCapabilitiesV2 } from "./OpenCodeAdapterV2.ts";

const capabilities = {
  ...OpenCodeProviderCapabilitiesV2,
  threads: { ...OpenCodeProviderCapabilitiesV2.threads, canForkFromSubagentThread: false },
  turns: { ...OpenCodeProviderCapabilitiesV2.turns, supportsActiveSteering: false },
  tools: { ...OpenCodeProviderCapabilitiesV2.tools, supportsMcpTools: false },
  planning: {
    ...OpenCodeProviderCapabilitiesV2.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    supportsStructuredQuestions: true,
  },
  subagents: {
    ...OpenCodeProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canForkSubagentThread: false,
  },
};

/** Native wire ids are scoped by instance, session, message and content ordinal. */
function itemIdentity(instance: string, session: string, message: string, part: string | number) {
  return JSON.stringify([instance, session, message, part]);
}

function modelRef(selection: ModelSelection) {
  const parsed = parseOpenCodeModelSlug(selection.model);
  if (!parsed) return undefined;
  const variant = getModelSelectionStringOptionValue(selection, "variant");
  return { providerID: parsed.providerID, id: parsed.modelID, ...(variant ? { variant } : {}) };
}

export function make(options: {
  readonly instanceId: ProviderInstanceId;
  readonly connect: Effect.Effect<OpenCodeClient, OpenCodeRuntimeError, Scope.Scope>;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly fileSystem: Pick<FileSystem.FileSystem, "realPath">;
  readonly serverConfig: Pick<ServerConfig["Service"], "cwd" | "attachmentsDir">;
}): ProviderAdapterV2Shape {
  const driver = OPENCODE_PROVIDER;
  const unsupported = (operation: string) =>
    Effect.fail(
      new ProviderAdapterProtocolError({
        driver,
        detail: `OpenCode 2 does not expose ${operation} through this adapter`,
      }),
    );
  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const client = yield* options.connect;
        const scope = yield* Effect.scope;
        const mutex = yield* Semaphore.make(1);
        const queue = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        const connected = yield* Deferred.make<void>();
        const now = yield* DateTime.now;
        const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
        const ids = options.idAllocator;
        const ref = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
        const requestItems = new Map<string, OrchestrationV2TurnItem>();
        const requestNodes = new Map<string, OrchestrationV2ExecutionNode>();
        const liveNodes = new Map<string, OrchestrationV2ExecutionNode>();
        const liveItems = new Map<string, OrchestrationV2TurnItem>();
        const emit = (event: ProviderAdapterV2Event) =>
          Effect.sync(() => {
            if (event.type === "node.updated") liveNodes.set(event.node.id, event.node);
            if (event.type === "turn_item.updated")
              liveItems.set(event.turnItem.id, event.turnItem);
            if (event.type === "turn_item.updated" && "requestId" in event.turnItem)
              requestItems.set(event.turnItem.requestId, event.turnItem);
            if (event.type === "node.updated" && event.node.runtimeRequestId)
              requestNodes.set(event.node.runtimeRequestId, event.node);
          }).pipe(Effect.andThen(Queue.offer(queue, event)), Effect.asVoid);
        const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
          Native.request(operation, run).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProtocolError({
                  driver,
                  detail: `OpenCode 2 ${operation} failed`,
                  cause,
                }),
            ),
          );
        let thread: OrchestrationV2ProviderThread | undefined;
        let sessionID: string | undefined;
        type Turn = {
          input: ProviderAdapterV2TurnInput;
          turn: OrchestrationV2ProviderTurn;
          ordinal: number;
          parts: Map<string, number>;
          admission: Deferred.Deferred<void>;
          generation: number;
          waiter?: Fiber.Fiber<unknown, unknown>;
        };
        let active: Turn | undefined;
        let closing = false;
        let starting: symbol | undefined;
        let stopGeneration = 0;
        let pendingContext = "";
        let currentModel = input.modelSelection.model;
        const turns = new Map<string, OrchestrationV2ProviderTurn>();
        const messages = new Map<string, OrchestrationV2ConversationMessage>();
        const pending = new Map<
          string,
          { native: PermissionRequest | FormInfo; request: OrchestrationV2RuntimeRequest }
        >();
        const seen = new Set<string>();
        const text = new Map<string, string>();
        const tools = new Map<string, SessionMessageAssistantTool>();
        const reconciledParts = new Set<string>();
        const nativeMessages = new Set<string>();
        const initial = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: options.instanceId,
          status: "ready" as const,
          cwd,
          model: input.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const resolveRequest = Effect.fn("OpenCode2Adapter.resolveRequest")(function* (
          requestId: string,
          status: "resolved" | "cancelled" = "resolved",
        ) {
          const value = pending.get(requestId);
          if (!value) return;
          pending.delete(requestId);
          const at = yield* DateTime.now;
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId: input.threadId,
            runtimeRequest: { ...value.request, status, resolvedAt: at },
          });
          const node = requestNodes.get(requestId);
          const item = requestItems.get(requestId);
          if (node)
            yield* emit({
              type: "node.updated",
              driver,
              node: {
                ...node,
                status: status === "cancelled" ? "cancelled" : "completed",
                completedAt: at,
              },
            });
          if (item)
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...item,
                status: status === "cancelled" ? "cancelled" : "completed",
                completedAt: at,
                updatedAt: at,
              },
            });
          requestNodes.delete(requestId);
          requestItems.delete(requestId);
        });

        const project = Effect.fn("OpenCode2Adapter.project")(function* (
          messageID: string,
          part: string | number,
          value: string,
          kind: "text" | "reasoning",
          completed: boolean,
        ) {
          const turn = active;
          if (!turn || !thread || !sessionID) return;
          const at = yield* DateTime.now;
          const nativeItemId = itemIdentity(options.instanceId, sessionID, messageID, part);
          let ordinal = turn.parts.get(nativeItemId);
          if (ordinal === undefined) {
            ordinal = turn.ordinal++;
            turn.parts.set(nativeItemId, ordinal);
          }
          const nodeId = ids.derive.nodeFromProviderItem({ driver, nativeItemId });
          const messageId = ids.derive.messageFromProviderItem({ driver, nativeItemId });
          const base = {
            id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId }),
            threadId: input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: thread.id,
            providerTurnId: turn.turn.id,
            nativeItemRef: ref(nativeItemId),
            parentItemId: null,
            ordinal,
            status: completed ? ("completed" as const) : ("running" as const),
            title: null,
            startedAt: turn.turn.startedAt ?? at,
            completedAt: completed ? at : null,
            updatedAt: at,
          };
          yield* emit({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: input.threadId,
              runId: turn.input.runId,
              parentNodeId: turn.input.rootNodeId,
              rootNodeId: turn.input.rootNodeId,
              kind: kind === "text" ? "assistant_message" : "reasoning",
              status: base.status,
              countsForRun: false,
              providerThreadId: thread.id,
              providerTurnId: turn.turn.id,
              nativeItemRef: base.nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: base.startedAt,
              completedAt: base.completedAt,
            },
          });
          if (kind === "text") {
            const message: OrchestrationV2ConversationMessage = {
              id: messageId,
              threadId: input.threadId,
              runId: turn.input.runId,
              nodeId,
              createdBy: "agent",
              creationSource: "provider",
              role: "assistant",
              text: value,
              attachments: [],
              streaming: !completed,
              createdAt: base.startedAt,
              updatedAt: at,
            };
            messages.set(messageId, message);
            yield* emit({ type: "message.updated", driver, message });
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...base,
                type: "assistant_message",
                messageId,
                text: value,
                streaming: !completed,
              },
            });
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: { ...base, type: "reasoning", text: value, streaming: !completed },
            });
          }
        });

        const projectTool = Effect.fn("OpenCode2Adapter.projectTool")(function* (
          messageID: string,
          tool: SessionMessageAssistantTool,
        ) {
          const turn = active;
          if (!turn || !thread || !sessionID) return;
          const at = yield* DateTime.now;
          const nativeItemId = itemIdentity(options.instanceId, sessionID, messageID, tool.id);
          let ordinal = turn.parts.get(nativeItemId);
          if (ordinal === undefined) {
            ordinal = turn.ordinal++;
            turn.parts.set(nativeItemId, ordinal);
          }
          const status =
            tool.state.status === "error"
              ? ("failed" as const)
              : tool.state.status === "completed"
                ? ("completed" as const)
                : ("running" as const);
          const nodeId = ids.derive.nodeFromProviderItem({ driver, nativeItemId });
          const output =
            tool.state.status === "error"
              ? tool.state.error.message
              : "metadata" in tool.state && typeof tool.state.metadata?.output === "string"
                ? tool.state.metadata.output
                : "content" in tool.state
                  ? (tool.state.content ?? [])
                      .flatMap((content) => (content.type === "text" ? [content.text] : []))
                      .join("\n")
                  : "";
          yield* emit({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: input.threadId,
              runId: turn.input.runId,
              parentNodeId: turn.input.rootNodeId,
              rootNodeId: turn.input.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: thread.id,
              providerTurnId: turn.turn.id,
              nativeItemRef: ref(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.turn.startedAt,
              completedAt: status === "running" ? null : at,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId }),
              threadId: input.threadId,
              runId: turn.input.runId,
              nodeId,
              providerThreadId: thread.id,
              providerTurnId: turn.turn.id,
              nativeItemRef: ref(nativeItemId),
              parentItemId: null,
              ordinal,
              type: "dynamic_tool",
              title: tool.name,
              toolName: tool.name,
              input: tool.state.input,
              output,
              status,
              startedAt: turn.turn.startedAt,
              completedAt: status === "running" ? null : at,
              updatedAt: at,
            },
          });
        });

        const projectMessage = Effect.fn("OpenCode2Adapter.projectMessage")(function* (
          message: SessionMessageAssistant,
        ) {
          for (const [ordinal, content] of message.content.entries()) {
            if (content.type === "text" || content.type === "reasoning") {
              text.set(`${message.id}:${ordinal}`, content.text);
              yield* project(
                message.id,
                ordinal,
                content.text,
                content.type,
                message.time.completed !== undefined,
              );
            } else {
              tools.set(`${message.id}:${content.id}`, content);
              yield* projectTool(message.id, content);
            }
          }
        });

        const settle = Effect.fn("OpenCode2Adapter.settle")(function* (
          expected: NonNullable<typeof active>,
          status: "completed" | "interrupted" | "failed",
          transportFailure?: unknown,
        ) {
          if (active !== expected || !thread) return;
          const at = yield* DateTime.now;
          for (const requestId of pending.keys()) yield* resolveRequest(requestId, "cancelled");
          for (const message of messages.values()) {
            if (message.runId !== expected.input.runId || !message.streaming) continue;
            const completed = { ...message, streaming: false, updatedAt: at };
            messages.set(message.id, completed);
            yield* emit({ type: "message.updated", driver, message: completed });
          }
          for (const node of liveNodes.values()) {
            if (
              node.providerTurnId === expected.turn.id &&
              (node.status === "running" || node.status === "waiting" || node.status === "pending")
            )
              yield* emit({
                type: "node.updated",
                driver,
                node: { ...node, status, completedAt: at },
              });
          }
          for (const item of liveItems.values()) {
            if (
              item.providerTurnId !== expected.turn.id ||
              (item.status !== "running" && item.status !== "waiting" && item.status !== "pending")
            )
              continue;
            const completed = { ...item, status, completedAt: at, updatedAt: at };
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: "streaming" in completed ? { ...completed, streaming: false } : completed,
            });
          }
          const turn = { ...expected.turn, status, completedAt: at };
          turns.set(turn.id, turn);
          yield* emit({
            type: "provider_turn.updated",
            driver,
            threadId: input.threadId,
            providerTurn: turn,
          });
          if (status === "failed") {
            yield* emit({
              type: "turn.terminal",
              driver,
              providerThreadId: thread.id,
              providerTurnId: turn.id,
              runOrdinal: expected.input.runOrdinal,
              failureItemOrdinal: expected.ordinal++,
              status,
              failure: makeProviderFailure({
                message: "OpenCode 2 execution failed.",
                class: transportFailure === undefined ? "provider_error" : "transport_error",
                ...(transportFailure === undefined ? {} : { cause: transportFailure }),
              }),
              threadDisposition: transportFailure === undefined ? "reusable" : "broken",
            });
          } else {
            yield* emit({
              type: "turn.terminal",
              driver,
              providerThreadId: thread.id,
              providerTurnId: turn.id,
              runOrdinal: expected.input.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
          }
          active = undefined;
          yield* emit({
            type: "provider_session.updated",
            driver,
            providerSession: { ...initial, model: currentModel, status: "ready", updatedAt: at },
          });
        });

        const ask = Effect.fn("OpenCode2Adapter.ask")(function* (
          native: PermissionRequest | FormInfo,
        ) {
          if (!active || !thread || [...pending.values()].some((p) => p.native.id === native.id))
            return;
          const form = "fields" in native;
          if (active.generation !== stopGeneration) {
            if (form)
              yield* call("form.cancel", (signal) =>
                client.session.form.cancel(
                  { sessionID: native.sessionID, formID: native.id },
                  { signal },
                ),
              );
            else
              yield* call("permission.reply", (signal) =>
                client.permission.reply(
                  { sessionID: native.sessionID, requestID: native.id, decision: "reject" },
                  { signal },
                ),
              );
            return;
          }
          if (form && !Forms.supported(native)) {
            yield* call("form.cancel", (signal) =>
              client.session.form.cancel(
                { sessionID: native.sessionID, formID: native.id },
                { signal },
              ),
            );
            return;
          }
          if (!form && input.runtimePolicy.runtimeMode === "full-access") {
            const result = yield* call("permission.reply", (signal) =>
              client.permission.reply(
                { sessionID: native.sessionID, requestID: native.id, decision: "once" },
                { signal },
              ),
            ).pipe(Effect.exit);
            if (result._tag === "Success") return;
          }
          const requestId = yield* ids.allocate.runtimeRequest({
            driver,
            providerTurnId: active.turn.id,
            nativeRequestId: native.id,
          });
          const nodeId = ids.derive.approvalNode({ requestId });
          const at = yield* DateTime.now;
          const kind = form
            ? ("user_input" as const)
            : native.action === "edit"
              ? ("file-change" as const)
              : ("command" as const);
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: active.turn.id,
            nativeRequestRef: ref(native.id),
            kind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt: at,
            resolvedAt: null,
          };
          pending.set(requestId, { native, request });
          yield* emit({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: input.threadId,
              runId: active.input.runId,
              parentNodeId: active.input.rootNodeId,
              rootNodeId: active.input.rootNodeId,
              kind: form ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: thread.id,
              providerTurnId: active.turn.id,
              nativeItemRef: ref(native.id),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: at,
              completedAt: null,
            },
          });
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId: input.threadId,
            runtimeRequest: request,
          });
          const base = {
            id: ids.derive.approvalTurnItem({ requestId }),
            threadId: input.threadId,
            runId: active.input.runId,
            nodeId,
            providerThreadId: thread.id,
            providerTurnId: active.turn.id,
            nativeItemRef: ref(native.id),
            parentItemId: null,
            ordinal: active.ordinal++,
            status: "waiting" as const,
            startedAt: at,
            completedAt: null,
            updatedAt: at,
            requestId,
          };
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: form
              ? {
                  ...base,
                  type: "user_input_request",
                  title: native.title,
                  questions: Forms.questions(native),
                }
              : {
                  ...base,
                  type: "approval_request",
                  title: native.action,
                  requestKind: kind === "user_input" ? "command" : kind,
                  prompt: native.resources.join("\n"),
                  options: [
                    { decision: "accept", label: "Allow once" },
                    { decision: "acceptAlways", label: "Always allow for this project" },
                    { decision: "decline", label: "Reject" },
                  ],
                },
          });
        });

        const reconcile = Effect.fn("OpenCode2Adapter.reconcile")(function* () {
          if (!sessionID || !active) return;
          const history = yield* Native.messages(client, sessionID);
          for (const message of history) {
            if (message.type === "assistant" && !nativeMessages.has(message.id)) {
              for (const [index, part] of message.content.entries())
                if (part.type !== "tool") reconciledParts.add(`${message.id}:${index}`);
              yield* projectMessage(message);
            }
          }
          const permissions = yield* call("permission.list", (signal) =>
            client.permission.list({ sessionID: sessionID! }, { signal }),
          );
          const forms = yield* call("form.list", (signal) =>
            client.session.form.list({ sessionID: sessionID! }, { signal }),
          );
          const pendingIds = new Set([...permissions, ...forms].map((value) => value.id));
          for (const [id, value] of pending)
            if (!pendingIds.has(value.native.id)) yield* resolveRequest(id);
          for (const permission of permissions) yield* ask(permission);
          for (const form of forms) yield* ask(form);
        });

        const handle = Effect.fn("OpenCode2Adapter.handle")(function* (event: OpenCodeEvent) {
          if (event.type === "server.connected") {
            yield* Deferred.succeed(connected, undefined);
            yield* reconcile();
            return;
          }
          const eventSession =
            event.type === "form.created"
              ? event.data.form.sessionID
              : "sessionID" in event.data
                ? event.data.sessionID
                : undefined;
          if (!active || !sessionID || eventSession !== sessionID) return;
          if (
            "assistantMessageID" in event.data &&
            nativeMessages.has(event.data.assistantMessageID)
          )
            return;
          if (seen.has(event.id)) return;
          if (seen.size >= 4096) seen.clear();
          seen.add(event.id);
          switch (event.type) {
            case "permission.asked":
              yield* ask(event.data);
              break;
            case "form.created":
              yield* ask(event.data.form);
              break;
            case "permission.replied":
            case "form.replied":
            case "form.cancelled": {
              const id = event.type === "permission.replied" ? event.data.requestID : event.data.id;
              for (const [requestId, value] of pending)
                if (value.native.id === id)
                  yield* resolveRequest(
                    requestId,
                    event.type === "form.cancelled" ? "cancelled" : "resolved",
                  );
              break;
            }
            case "session.tool.input.started":
            case "session.tool.called":
            case "session.tool.progress":
            case "session.tool.success":
            case "session.tool.failed": {
              const key = `${event.data.assistantMessageID}:${event.data.id}`;
              let tool = tools.get(key);
              if (tool?.state.status === "completed" || tool?.state.status === "error") break;
              if (event.type === "session.tool.input.started") {
                tool = {
                  type: "tool",
                  id: event.data.id,
                  name: event.data.name,
                  state: { status: "streaming", input: "" },
                  time: { created: event.created },
                };
              } else if (tool) {
                if (event.type === "session.tool.called")
                  tool = {
                    ...tool,
                    state: { status: "running", input: event.data.input, metadata: {} },
                    time: { ...tool.time, ran: event.created },
                  };
                else if (event.type === "session.tool.progress" && tool.state.status === "running")
                  tool = { ...tool, state: { ...tool.state, metadata: event.data.metadata } };
                else if (event.type === "session.tool.success") {
                  const normalize = (part: (typeof event.data.content)[number]) =>
                    part.type === "file" ? { ...part, name: part.name ?? null } : part;
                  const [first, ...rest] = event.data.content;
                  tool = {
                    ...tool,
                    state: {
                      status: "completed",
                      input: typeof tool.state.input === "string" ? {} : tool.state.input,
                      content: [normalize(first), ...rest.map(normalize)],
                    },
                    time: { ...tool.time, completed: event.created },
                  };
                } else if (event.type === "session.tool.failed")
                  tool = {
                    ...tool,
                    state: {
                      status: "error",
                      input: typeof tool.state.input === "string" ? {} : tool.state.input,
                      error: event.data.error,
                    },
                    time: { ...tool.time, completed: event.created },
                  };
              } else {
                const message = yield* call("session.message.get", (signal) =>
                  client.session.message.get(
                    { sessionID: sessionID!, messageID: event.data.assistantMessageID },
                    { signal },
                  ),
                );
                if (message.type === "assistant") yield* projectMessage(message);
                break;
              }
              if (tool) {
                tools.set(key, tool);
                yield* projectTool(event.data.assistantMessageID, tool);
              }
              break;
            }
            case "session.text.delta":
            case "session.reasoning.delta": {
              const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
              // A reconnect snapshot can include deltas already queued on the new stream.
              // Wait for this part's authoritative end instead of appending them twice.
              if (reconciledParts.has(key)) break;
              const value = (text.get(key) ?? "") + event.data.delta;
              text.set(key, value);
              yield* project(
                event.data.assistantMessageID,
                event.data.ordinal,
                value,
                event.type === "session.text.delta" ? "text" : "reasoning",
                false,
              );
              break;
            }
            case "session.text.ended":
            case "session.reasoning.ended": {
              text.set(`${event.data.assistantMessageID}:${event.data.ordinal}`, event.data.text);
              yield* project(
                event.data.assistantMessageID,
                event.data.ordinal,
                event.data.text,
                event.type === "session.text.ended" ? "text" : "reasoning",
                true,
              );
              break;
            }
          }
        });

        const stream = Stream.fromAsyncIterable(
          client.event.subscribe(),
          (cause) => new Native.OpenCode2RequestError({ operation: "event.subscribe", cause }),
        );
        const pump = Effect.gen(function* () {
          let attempt = 0;
          for (;;) {
            if (closing) return;
            yield* Stream.runForEach(stream, (event) => mutex.withPermit(handle(event))).pipe(
              Effect.exit,
            );
            if (closing) break;
            yield* Effect.sleep(Math.min(250 * 2 ** attempt++, 5000));
          }
        });
        yield* pump.pipe(Effect.forkIn(scope));
        yield* Deferred.await(connected).pipe(Effect.timeout("10 seconds"));
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closing = true;
            if (sessionID && active)
              yield* call("session.interrupt", (signal) =>
                client.session.interrupt({ sessionID: sessionID!, resume: false }, { signal }),
              ).pipe(Effect.ignore);
          }),
        );

        const adopt = Effect.fn("OpenCode2Adapter.adopt")(function* (
          native: SessionInfo,
          existing?: OrchestrationV2ProviderThread,
        ) {
          if (native.location.directory !== cwd) {
            const paths = yield* Effect.all(
              [native.location.directory, cwd].map((directory) =>
                options.fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => directory)),
              ),
            );
            if (paths[0] !== paths[1])
              return yield* new ProviderAdapterProtocolError({
                driver,
                detail: "The saved OpenCode session belongs to another working directory",
              });
          }
          sessionID = native.id;
          const at = yield* DateTime.now;
          thread = {
            id:
              existing?.id ??
              ids.derive.providerThread({
                driver,
                nativeThreadId: native.id,
                providerInstanceId: options.instanceId,
              }),
            driver,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: ref(native.id),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
          };
          yield* call("session.update", (signal) =>
            client.session.update(
              {
                sessionID: native.id,
                permissions: Native.sessionRules(input.runtimePolicy.runtimeMode),
              },
              { signal },
            ),
          );
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
          return thread;
        });

        const snapshot = Effect.fn("OpenCode2Adapter.snapshot")(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const nativeID = providerThread.nativeThreadRef?.nativeId;
          if (!nativeID)
            return yield* new ProviderAdapterProtocolError({
              driver,
              detail: "Saved thread has no native OpenCode session",
            });
          const history = yield* Native.messages(client, nativeID).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProtocolError({
                  driver,
                  detail: "Cannot read OpenCode history",
                  cause,
                }),
            ),
          );
          const at = yield* DateTime.now;
          const projected: OrchestrationV2ConversationMessage[] = history.flatMap((message) => {
            if (message.type !== "user" && message.type !== "assistant") return [];
            const value =
              message.type === "user"
                ? message.text
                : message.content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("\n");
            return [
              {
                id: ids.derive.messageFromProviderItem({
                  driver,
                  nativeItemId: itemIdentity(options.instanceId, nativeID, message.id, "history"),
                }),
                threadId: providerThread.appThreadId ?? input.threadId,
                runId: null,
                nodeId: null,
                createdBy: message.type === "user" ? ("user" as const) : ("agent" as const),
                creationSource: "provider" as const,
                role: message.type,
                text: value,
                attachments: [],
                streaming: false,
                createdAt: DateTime.makeUnsafe(message.time.created),
                updatedAt: at,
              },
            ];
          });
          return {
            providerThread,
            providerTurns: [...turns.values()],
            messages: projected,
            runtimeRequests: [...pending.values()].map((p) => p.request),
          };
        });

        const boundaryAfter = (
          providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
          selectedId: string,
        ) => {
          const sorted = providerTurns.toSorted((a, b) => a.ordinal - b.ordinal);
          const index = sorted.findIndex((turn) => turn.id === selectedId);
          if (index < 0) return undefined;
          const next = sorted[index + 1]?.nativeTurnRef?.nativeId;
          return next ? { before: next } : {};
        };

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: initial,
          events: Stream.fromQueue(queue),
          injectHistory: (history) =>
            Effect.sync(() => {
              pendingContext = history.context;
              return true;
            }),
          ensureThread: (ensure) =>
            mutex.withPermit(
              Effect.gen(function* () {
                if (thread) return thread;
                const saved = ensure.existingProviderThread?.nativeThreadRef?.nativeId;
                const native = saved
                  ? yield* call("session.get", (signal) =>
                      client.session.get({ sessionID: saved }, { signal }),
                    )
                  : yield* call("session.create", (signal) =>
                      client.session.create(
                        {
                          location: { directory: cwd },
                          permissions: Native.sessionRules(ensure.runtimePolicy.runtimeMode),
                        },
                        { signal },
                      ),
                    );
                return yield* adopt(native, ensure.existingProviderThread);
              }),
            ),
          resumeThread: (resume) =>
            mutex.withPermit(
              Effect.gen(function* () {
                const saved = resume.providerThread.nativeThreadRef?.nativeId;
                if (!saved)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "Saved thread has no native OpenCode session",
                  });
                return yield* adopt(
                  yield* call("session.get", (signal) =>
                    client.session.get({ sessionID: saved }, { signal }),
                  ),
                  resume.providerThread,
                );
              }),
            ),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (!sessionID || !thread || active || starting || closing)
                return yield* new ProviderAdapterProtocolError({
                  driver,
                  detail: "OpenCode session is not idle",
                });
              const nativeID = sessionID;
              const providerThread = thread;
              const reservation = Symbol();
              const generation = stopGeneration;
              const admission = Deferred.makeUnsafe<void>();
              starting = reservation;
              return yield* Effect.gen(function* () {
                const model = modelRef(turnInput.modelSelection);
                if (!model)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode model must use provider/model syntax",
                  });
                const history = yield* Native.messages(client, nativeID).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterProtocolError({
                        driver,
                        detail: "Cannot load OpenCode 2 history",
                        cause,
                      }),
                  ),
                );
                nativeMessages.clear();
                messages.clear();
                liveItems.clear();
                liveNodes.clear();
                tools.clear();
                text.clear();
                reconciledParts.clear();
                for (const message of history) nativeMessages.add(message.id);
                yield* call("session.update", (signal) =>
                  client.session.update(
                    {
                      sessionID: nativeID,
                      permissions: Native.sessionRules(turnInput.runtimePolicy.runtimeMode),
                    },
                    { signal },
                  ),
                );
                yield* call("session.switchModel", (signal) =>
                  client.session.switchModel({ sessionID: nativeID, model }, { signal }),
                );
                currentModel = turnInput.modelSelection.model;
                const agent =
                  turnInput.runtimePolicy.interactionMode === "plan"
                    ? "plan"
                    : (getModelSelectionStringOptionValue(turnInput.modelSelection, "agent") ??
                      "build");
                yield* call("session.switchAgent", (signal) =>
                  client.session.switchAgent({ sessionID: nativeID, agent }, { signal }),
                );
                if (generation !== stopGeneration || closing)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode turn start was cancelled",
                  });
                const startedAt = yield* DateTime.now;
                const turn: OrchestrationV2ProviderTurn = {
                  id: ids.derive.providerTurn({
                    driver,
                    nativeTurnId: `${options.instanceId}:${turnInput.attemptId}`,
                  }),
                  providerThreadId: providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: null,
                  ordinal: turnInput.providerTurnOrdinal,
                  status: "running",
                  startedAt,
                  completedAt: null,
                };
                const current: Turn = {
                  input: turnInput,
                  turn,
                  ordinal: 1,
                  parts: new Map(),
                  admission,
                  generation,
                };
                active = current;
                turns.set(turn.id, turn);
                yield* emit({
                  type: "provider_session.updated",
                  driver,
                  providerSession: {
                    ...initial,
                    model: currentModel,
                    status: "running",
                    updatedAt: startedAt,
                  },
                });
                yield* emit({
                  type: "provider_turn.updated",
                  driver,
                  threadId: input.threadId,
                  providerTurn: turn,
                });
                const files = toOpenCodeFileParts({
                  attachments: turnInput.message.attachments,
                  resolveAttachmentPath: (attachment) =>
                    resolveAttachmentPath({
                      attachmentsDir: options.serverConfig.attachmentsDir,
                      attachment,
                    }),
                }).map((file) => ({ uri: file.url }));
                const prompt = [
                  pendingContext,
                  providerMessageTextWithAttachmentPaths({
                    text: turnInput.message.text,
                    attachments: turnInput.message.attachments,
                    attachmentsDir: options.serverConfig.attachmentsDir,
                  }),
                ]
                  .filter(Boolean)
                  .join("\n\n");
                const admitted = yield* Effect.gen(function* () {
                  if (generation !== stopGeneration || closing)
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail: "OpenCode turn start was cancelled",
                    });
                  if (turnInput.message.text.trim() === "/compact")
                    return yield* call("session.compact", (signal) =>
                      client.session.compact({ sessionID: nativeID }, { signal }),
                    );
                  return yield* call("session.prompt", (signal) =>
                    client.session.prompt({ sessionID: nativeID, text: prompt, files }, { signal }),
                  );
                }).pipe(
                  Effect.onError(() =>
                    mutex.withPermit(
                      settle(current, generation !== stopGeneration ? "interrupted" : "failed"),
                    ),
                  ),
                );
                pendingContext = "";
                current.turn = { ...turn, nativeTurnRef: ref(admitted.id) };
                current.waiter = yield* Effect.gen(function* () {
                  yield* Effect.tryPromise({
                    try: (signal) => client.session.wait({ sessionID: nativeID }, { signal }),
                    catch: (cause) =>
                      new Native.OpenCode2RequestError({ operation: "session.wait", cause }),
                  });
                  yield* mutex.withPermit(
                    Effect.gen(function* () {
                      if (active !== current) return;
                      yield* reconcile();
                      const state = yield* call("session.get", (signal) =>
                        client.session.get({ sessionID: nativeID }, { signal }),
                      );
                      yield* settle(
                        current,
                        current.generation !== stopGeneration
                          ? "interrupted"
                          : state.outcome === "failed"
                            ? "failed"
                            : state.outcome === "interrupted"
                              ? "interrupted"
                              : "completed",
                      );
                    }),
                  );
                }).pipe(
                  Effect.catch((cause) =>
                    call("session.interrupt", (signal) =>
                      client.session.interrupt({ sessionID: nativeID, resume: false }, { signal }),
                    ).pipe(
                      Effect.ignore,
                      Effect.andThen(mutex.withPermit(settle(current, "failed", cause))),
                    ),
                  ),
                  Effect.forkIn(scope),
                );
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    if (starting === reservation) starting = undefined;
                    yield* Deferred.succeed(admission, undefined);
                  }),
                ),
              );
            }),
          compactThread: (value) =>
            runtime.startTurn({ ...value, message: { ...value.message, text: "/compact" } }),
          steerTurn: () => unsupported("active steering; interrupt and restart the turn instead"),
          interruptTurn: () =>
            Effect.gen(function* () {
              stopGeneration += 1;
              const current = active;
              if (!sessionID || !current) return;
              // Prompt hooks can wait for a form before admission. Reject those
              // gates first so Stop never waits for the user to answer them.
              yield* mutex.withPermit(
                Effect.gen(function* () {
                  for (const [requestId, value] of pending) {
                    const native = value.native;
                    if ("fields" in native)
                      yield* call("form.cancel", (signal) =>
                        client.session.form.cancel(
                          { sessionID: native.sessionID, formID: native.id },
                          { signal },
                        ),
                      );
                    else
                      yield* call("permission.reply", (signal) =>
                        client.permission.reply(
                          { sessionID: native.sessionID, requestID: native.id, decision: "reject" },
                          { signal },
                        ),
                      );
                    yield* resolveRequest(requestId, "cancelled");
                  }
                }),
              );
              // Do not interrupt before an in-flight prompt has been admitted.
              // Its bounded request owns this receipt, including failure and cancellation.
              yield* Deferred.await(current.admission);
              yield* call("session.interrupt", (signal) =>
                client.session.interrupt({ sessionID: sessionID!, resume: false }, { signal }),
              );
              yield* mutex.withPermit(settle(current, "interrupted"));
            }),
          respondToRuntimeRequest: (response) =>
            mutex.withPermit(
              Effect.gen(function* () {
                const value = pending.get(response.requestId);
                if (!value)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode request is no longer pending",
                  });
                if ("fields" in value.native) {
                  const native = value.native;
                  const answer = yield* Forms.answer(native, response.answers ?? {}).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterProtocolError({
                          driver,
                          detail: "Invalid OpenCode form answer",
                          cause,
                        }),
                    ),
                  );
                  yield* call("form.reply", (signal) =>
                    client.session.form.reply(
                      { sessionID: native.sessionID, formID: native.id, answer },
                      { signal },
                    ),
                  );
                } else {
                  const native = value.native;
                  if (response.decision === "acceptForSession")
                    return yield* new ProviderAdapterProtocolError({
                      driver,
                      detail:
                        "OpenCode supports one-time or project-wide approval, not session-wide approval",
                    });
                  const decision =
                    response.decision === "accept"
                      ? "once"
                      : response.decision === "acceptAlways"
                        ? "always"
                        : "reject";
                  yield* call("permission.reply", (signal) =>
                    client.permission.reply(
                      { sessionID: native.sessionID, requestID: native.id, decision },
                      { signal },
                    ),
                  );
                }
                yield* resolveRequest(response.requestId);
              }),
            ),
          readThreadSnapshot: (value) => snapshot(value.providerThread),
          rollbackThread: (value) =>
            mutex.withPermit(
              Effect.gen(function* () {
                if (active || starting || !sessionID)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "Cannot roll back an active OpenCode session",
                  });
                const boundary =
                  value.target.type === "provider_turn"
                    ? boundaryAfter(value.providerThreadTurns, value.target.providerTurn.id)
                    : undefined;
                if (value.target.type === "provider_turn" && !boundary)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode rollback boundary is missing",
                  });
                const nativeID = sessionID;
                const native =
                  value.target.type === "thread_start"
                    ? yield* call("session.create", (signal) =>
                        client.session.create(
                          {
                            location: { directory: cwd },
                            permissions: Native.sessionRules(input.runtimePolicy.runtimeMode),
                          },
                          { signal },
                        ),
                      )
                    : yield* call("session.fork", (signal) =>
                        client.session.fork({ sessionID: nativeID, ...boundary }, { signal }),
                      );
                const updated = yield* adopt(native, value.providerThread);
                for (const [id, turn] of turns)
                  if (
                    value.target.type === "thread_start" ||
                    turn.ordinal > value.target.providerTurn.ordinal
                  )
                    turns.delete(id);
                return yield* snapshot(updated);
              }),
            ),
          forkThread: (value) =>
            mutex.withPermit(
              Effect.gen(function* () {
                if (active || starting)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "Cannot fork an active OpenCode session",
                  });
                const nativeID = value.sourceProviderThread.nativeThreadRef?.nativeId;
                if (!nativeID)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode source session is missing",
                  });
                const boundary = value.providerTurnId
                  ? boundaryAfter(value.sourceProviderTurns ?? [], value.providerTurnId)
                  : {};
                if (!boundary)
                  return yield* new ProviderAdapterProtocolError({
                    driver,
                    detail: "OpenCode fork boundary is missing",
                  });
                const native = yield* call("session.fork", (signal) =>
                  client.session.fork({ sessionID: nativeID, ...boundary }, { signal }),
                );
                const destination = value.runtimePolicy?.cwd;
                if (destination && destination !== native.location.directory) {
                  yield* call("session.move", (signal) =>
                    client.session.move(
                      { sessionID: native.id, directory: destination },
                      { signal },
                    ),
                  ).pipe(
                    Effect.andThen(
                      call("session.wait", (signal) =>
                        client.session.wait({ sessionID: native.id }, { signal }),
                      ),
                    ),
                    Effect.onError(() =>
                      call("session.remove", (signal) =>
                        client.session.remove({ sessionID: native.id }, { signal }),
                      ).pipe(Effect.ignore),
                    ),
                  );
                }
                return {
                  ...value.sourceProviderThread,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  id: ids.derive.providerThread({
                    driver,
                    nativeThreadId: native.id,
                    providerInstanceId: options.instanceId,
                  }),
                  appThreadId: value.targetThreadId,
                  ownerNodeId: value.ownerNodeId ?? null,
                  nativeThreadRef: ref(native.id),
                  nativeConversationHeadRef: null,
                  forkedFrom: {
                    providerThreadId: value.sourceProviderThread.id,
                    ...(value.providerTurnId ? { providerTurnId: value.providerTurnId } : {}),
                  },
                  createdAt: yield* DateTime.now,
                  updatedAt: yield* DateTime.now,
                };
              }),
            ),
        };
        return runtime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
}
