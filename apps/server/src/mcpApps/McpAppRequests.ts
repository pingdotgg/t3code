import {
  McpAppRequestError,
  type McpAppCallToolInput,
  type McpAppCallToolResult,
  type McpAppReadResourceInput,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type McpAppToolInfoInput,
  type McpAppUpdateModelContextInput,
  type OrchestrationV2AppThread,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { mcpAppToolCallableByApp, type McpAppReference } from "@t3tools/shared/mcpApp";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2McpApps,
  ProviderAdapterV2McpTool,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";

/**
 * Requests an MCP App makes of its own MCP server. The app is resolved from the
 * tool call that produced it, so it reaches only that server, and each request
 * runs through the thread's live provider session, whose MCP client owns the
 * connection and its credentials. A stopped session is reported, never
 * started: an app view must not spend a provider turn.
 */
export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
    readonly updateModelContext: (
      input: McpAppUpdateModelContextInput,
    ) => Effect.Effect<void, McpAppRequestError>;
  }
>()("t3/mcpApps/McpAppRequests") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextEncoder();

const readOnlyHint = (tool: ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && tool.annotations.readOnlyHint === true;

const toolTitle = (tool: ProviderAdapterV2McpTool) =>
  Predicate.isObject(tool.annotations) && typeof tool.annotations.title === "string"
    ? tool.annotations.title
    : undefined;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const modelContext = yield* McpAppModelContext.McpAppModelContext;

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  /** The app a tool call produced, read from the stored item. */
  const resolveApp = Effect.fn("McpAppRequests.resolveApp")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    // The stored item, not the wire projection, so the reference is intact.
    const item = yield* orchestrator
      .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const app: McpAppReference | undefined =
      item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (item === null || app === undefined || item.providerThreadId === null) {
      return yield* fail(input.threadId, "not-an-app");
    }
    return { app, providerThreadId: item.providerThreadId };
  });

  /** The app, its provider thread, and the live session's MCP Apps operations. */
  const resolve = Effect.fn("McpAppRequests.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    const { app, providerThreadId } = yield* resolveApp(input);
    const projection = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    if (providerThread?.providerSessionId == null) {
      return yield* fail(input.threadId, "session-stopped");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail(input.threadId, "session-stopped");
    const mcpApps: ProviderAdapterV2McpApps | undefined = runtime.mcpApps;
    if (mcpApps === undefined) return yield* fail(input.threadId, "provider-unsupported");
    return { app, providerThread, mcpApps };
  });

  const findTool = Effect.fn("McpAppRequests.findTool")(function* (
    threadId: ThreadId,
    resolved: Effect.Success<ReturnType<typeof resolve>>,
    name: string,
  ) {
    const tools = yield* resolved.mcpApps
      .listTools({ providerThread: resolved.providerThread, server: resolved.app.server })
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    return tools.find((tool) => tool.name === name);
  });

  const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (input: McpAppToolInfoInput) {
    const resolved = yield* resolve(input);
    const tool = yield* findTool(input.threadId, resolved, input.name);
    const title = tool === undefined ? undefined : toolTitle(tool);
    return {
      callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
      readOnly: tool !== undefined && readOnlyHint(tool),
      ...(title === undefined ? {} : { title }),
      ...(tool === undefined ? {} : { tool }),
    } satisfies McpAppToolInfo;
  });

  const callTool = Effect.fn("McpAppRequests.callTool")(function* (input: McpAppCallToolInput) {
    const resolved = yield* resolve(input);
    // The spec forbids apps calling tools hidden from them; checked here too,
    // since a client's own check is only a courtesy to its user.
    const tool = yield* findTool(input.threadId, resolved, input.name);
    if (tool === undefined || !mcpAppToolCallableByApp(tool._meta)) {
      return yield* fail(input.threadId, "tool-not-callable");
    }
    return yield* resolved.mcpApps
      .callTool({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        tool: input.name,
        arguments: input.arguments,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  const readResource = Effect.fn("McpAppRequests.readResource")(function* (
    input: McpAppReadResourceInput,
  ) {
    const resolved = yield* resolve(input);
    return yield* resolved.mcpApps
      .readResource({
        providerThread: resolved.providerThread,
        server: resolved.app.server,
        uri: input.uri,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  // Context is state for the agent's next turn, so it needs the app but not a
  // live session. Text blocks are kept as written and structured content as
  // JSON; other content kinds are not declared by the host.
  /** Whether `threadId` is `ancestorId` or forked from it, however many forks deep. */
  const descendsFrom = Effect.fn("McpAppRequests.descendsFrom")(function* (
    threadId: ThreadId,
    ancestorId: ThreadId,
  ) {
    // Walks fork links until the chain ends; a thread seen twice means a
    // corrupt cycle, which proves nothing.
    const seen = new Set<ThreadId>();
    let current: ThreadId | null = threadId;
    while (current !== null && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      const records: { readonly thread: OrchestrationV2AppThread } = yield* threadManagement
        .getThreadRecords(current, [])
        .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
      const { lineage } = records.thread;
      current = lineage.relationshipToParent === "fork" ? lineage.parentThreadId : null;
    }
    return false;
  });

  const updateModelContext = Effect.fn("McpAppRequests.updateModelContext")(function* (
    input: McpAppUpdateModelContextInput,
  ) {
    const { app } = yield* resolveApp(input);
    // Context belongs to the conversation on screen, which only shows this app
    // when it is the app's own thread or one forked from it.
    if (!(yield* descendsFrom(input.conversationThreadId, input.threadId))) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const texts: Array<string> = [];
    for (const block of input.content ?? []) {
      if (!Predicate.isObject(block) || block.type !== "text" || typeof block.text !== "string") {
        return yield* fail(input.threadId, "unsupported-content");
      }
      texts.push(block.text);
    }
    if (input.structuredContent !== undefined) {
      texts.push(encodeJson(input.structuredContent));
    }
    // Kept as sent; blank text clears the app's context in the store.
    const text = texts.join("\n");
    if (utf8.encode(text).byteLength > McpAppModelContext.MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
      return yield* fail(
        input.threadId,
        "request-failed",
        new Error("Model context is too large."),
      );
    }
    yield* modelContext
      .set({
        threadId: input.conversationThreadId,
        itemId: input.itemId,
        server: app.server,
        tool: app.tool,
        text,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  return McpAppRequests.of({ callTool, toolInfo, readResource, updateModelContext });
});

export const layer = Layer.effect(McpAppRequests, make);
