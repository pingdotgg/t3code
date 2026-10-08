import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type McpAppRequestError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2McpApps,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";
import * as McpAppRequests from "./McpAppRequests.ts";

const threadId = ThreadId.make("thread-app");
const itemId = TurnItemId.make("item-app");
const providerThreadId = ProviderThreadId.make("provider-thread-app");
const providerSessionId = ProviderSessionId.make("provider-session-app");
const forkId = ThreadId.make("thread-fork");
const unrelatedId = ThreadId.make("thread-unrelated");
// A chain of forks deeper than any fixed walk limit: deep-70 → … → deep-1 → app.
const deepForkId = (depth: number) => ThreadId.make(`thread-deep-${depth}`);
const deepParent = (id: ThreadId): ThreadId | null => {
  const match = /^thread-deep-(\d+)$/.exec(id);
  if (match === null) return null;
  const depth = Number(match[1]);
  return depth === 1 ? threadId : deepForkId(depth - 1);
};

const appItem = (output: unknown): OrchestrationV2TurnItem => ({
  id: itemId,
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "dynamic_tool",
  toolName: "weather.get_weather",
  input: {},
  output,
});

const app = {
  attachmentId: "thread-app-00000000-0000-0000-0000-000000000000-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};

/** Each app's stored context, keyed by item, as the real store keeps it. */
const storedContext = new Map<string, string>();

function makeLayer(input: {
  readonly item: OrchestrationV2TurnItem | null;
  readonly mcpApps?: ProviderAdapterV2McpApps;
  readonly live?: boolean;
}) {
  return McpAppRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(McpAppModelContext.McpAppModelContext)({
          set: (entry) =>
            Effect.sync(() => {
              const key = `${entry.threadId}/${entry.itemId}`;
              if (entry.text.trim() === "") storedContext.delete(key);
              else storedContext.set(key, entry.text);
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getTurnItem: () => Effect.succeed(input.item),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id: ThreadId) =>
            Effect.succeed({
              // A fork of the app's thread, and an unrelated thread.
              thread: {
                lineage:
                  deepParent(id) !== null
                    ? {
                        parentThreadId: deepParent(id),
                        relationshipToParent: "fork",
                        rootThreadId: threadId,
                      }
                    : id === forkId
                      ? {
                          parentThreadId: threadId,
                          relationshipToParent: "fork",
                          rootThreadId: threadId,
                        }
                      : { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
              },
              providerThreads: [
                { id: providerThreadId, providerSessionId } as OrchestrationV2ProviderThread,
              ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some(
                    (input.mcpApps === undefined
                      ? {}
                      : { mcpApps: input.mcpApps }) as ProviderAdapterV2SessionRuntime,
                  ),
            ),
        }),
      ),
    ),
  );
}

const reason = <A, R>(effect: Effect.Effect<A, McpAppRequestError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("McpAppRequests", () => {
  const calls: Array<{ server: string; tool: string }> = [];
  const mcpApps: ProviderAdapterV2McpApps = {
    listTools: () =>
      Effect.succeed([
        { name: "refresh", annotations: { readOnlyHint: true } },
        { name: "model_only", _meta: { ui: { visibility: ["model"] } } },
      ]),
    callTool: (input) =>
      Effect.sync(() => {
        calls.push({ server: input.server, tool: input.tool });
        return { content: [{ type: "text", text: "ok" }] };
      }),
    readResource: () => Effect.succeed({ contents: [] }),
  };

  it.effect("calls tools on the app's own server and reports their read-only hint", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const result = yield* requests.callTool({
        threadId,
        itemId,
        name: "refresh",
        arguments: {},
      });
      assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
      assert.deepEqual(calls.at(-1), { server: "weather", tool: "refresh" });
      assert.deepEqual(yield* requests.toolInfo({ threadId, itemId, name: "refresh" }), {
        callable: true,
        readOnly: true,
        tool: { name: "refresh", annotations: { readOnlyHint: true } },
      });
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps }))),
  );

  it.effect("refuses tools hidden from apps or missing from the server", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const before = calls.length;
      for (const name of ["model_only", "unknown"]) {
        assert.equal(
          yield* reason(requests.callTool({ threadId, itemId, name, arguments: {} })),
          "tool-not-callable",
        );
      }
      assert.equal(calls.length, before);
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps }))),
  );

  it.effect("keeps each app's latest model context, without a live session", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const own = { threadId, itemId, conversationThreadId: threadId };
      // The app's text is stored as sent, whitespace included.
      yield* requests.updateModelContext({
        ...own,
        content: [{ type: "text", text: "  indented value  " }],
      });
      assert.equal(storedContext.get(`${threadId}/${itemId}`), "  indented value  ");
      // An update replaces the app's context rather than adding to it.
      yield* requests.updateModelContext({
        ...own,
        content: [{ type: "text", text: "Filtered to overdue" }],
        structuredContent: { filter: "overdue" },
      });
      assert.equal(
        storedContext.get(`${threadId}/${itemId}`),
        'Filtered to overdue\n{"filter":"overdue"}',
      );
      assert.equal(
        yield* reason(
          requests.updateModelContext({ ...own, content: [{ type: "image", data: "x" }] }),
        ),
        "unsupported-content",
      );
      // The cap is in UTF-8 bytes: 6,000 three-byte characters exceed 16 KiB.
      assert.equal(
        yield* reason(
          requests.updateModelContext({
            ...own,
            content: [{ type: "text", text: "表".repeat(6000) }],
          }),
        ),
        "request-failed",
      );
      yield* requests.updateModelContext(own);
      assert.isFalse(storedContext.has(`${threadId}/${itemId}`));
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), live: false }))),
  );

  it.effect("stores a fork's model context under the fork, and refuses unrelated threads", () =>
    Effect.gen(function* () {
      const requests = yield* McpAppRequests.McpAppRequests;
      const content = [{ type: "text", text: "Seen from the fork" }];
      yield* requests.updateModelContext({
        threadId,
        itemId,
        conversationThreadId: forkId,
        content,
      });
      assert.equal(storedContext.get(`${forkId}/${itemId}`), "Seen from the fork");
      assert.isFalse(storedContext.has(`${threadId}/${itemId}`));
      assert.equal(
        yield* reason(
          requests.updateModelContext({
            threadId,
            itemId,
            conversationThreadId: unrelatedId,
            content,
          }),
        ),
        "not-an-app",
      );
      // However many forks deep, a descendant still counts.
      yield* requests.updateModelContext({
        threadId,
        itemId,
        conversationThreadId: deepForkId(70),
        content,
      });
      assert.isTrue(storedContext.has(`${deepForkId(70)}/${itemId}`));
    }).pipe(Effect.provide(makeLayer({ item: appItem({ t3McpApp: app }), live: false }))),
  );

  it.effect("reports why a request cannot run", () =>
    Effect.gen(function* () {
      const run = (layer: ReturnType<typeof makeLayer>) =>
        Effect.gen(function* () {
          const requests = yield* McpAppRequests.McpAppRequests;
          return yield* reason(requests.readResource({ threadId, itemId, uri: "ui://weather/x" }));
        }).pipe(Effect.provide(layer));
      assert.equal(
        yield* run(makeLayer({ item: appItem({ result: "plain" }), mcpApps })),
        "not-an-app",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ t3McpApp: app }), mcpApps, live: false })),
        "session-stopped",
      );
      assert.equal(
        yield* run(makeLayer({ item: appItem({ t3McpApp: app }) })),
        "provider-unsupported",
      );
    }),
  );
});
