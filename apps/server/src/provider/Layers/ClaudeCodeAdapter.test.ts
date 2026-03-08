import assert from "node:assert/strict";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";

import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { ClaudeCodeServerManager } from "../../claudeCodeServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeClaudeCodeAdapterLive } from "./ClaudeCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
});

const lifecycleManager = new ClaudeCodeServerManager();
const lifecycleLayer = it.layer(
  makeClaudeCodeAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("ClaudeCodeAdapterLive lifecycle", (it) => {
  it.effect(
    "preserves exact whitespace in Claude content deltas while ignoring unrelated provider methods",
    () =>
      Effect.gen(function* () {
        const adapter = yield* ClaudeCodeAdapter;
        const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        lifecycleManager.emit("event", {
          id: asEventId("evt-ignored"),
          kind: "notification",
          provider: "claudeCode",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "stream/ping",
          payload: {},
        } satisfies ProviderEvent);

        lifecycleManager.emit("event", {
          id: asEventId("evt-delta"),
          kind: "notification",
          provider: "claudeCode",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          turnId: asTurnId("turn-1"),
          method: "turn/content-delta",
          payload: {
            streamKind: "assistant_text",
            delta: " let",
          },
        } satisfies ProviderEvent);

        const runtimeEvent = yield* Fiber.join(eventFiber);
        assert.equal(runtimeEvent._tag, "Some");
        if (runtimeEvent._tag !== "Some") {
          return;
        }

        assert.deepStrictEqual(runtimeEvent.value, {
          eventId: asEventId("evt-delta"),
          provider: "claudeCode",
          threadId: asThreadId("thread-1"),
          createdAt: runtimeEvent.value.createdAt,
          turnId: asTurnId("turn-1"),
          raw: {
            source: "claude-code.stream-json",
            method: "turn/content-delta",
            payload: {
              streamKind: "assistant_text",
              delta: " let",
            },
          },
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: " let",
          },
        });
      }),
  );

  it.effect("maps Claude runtime/error provider events into canonical runtime errors", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-runtime-error"),
        kind: "error",
        provider: "claudeCode",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        turnId: asTurnId("turn-2"),
        method: "runtime/error",
        message: "Claude stream overloaded",
        payload: {
          class: "provider_error",
          nativeType: "overloaded_error",
        },
      } satisfies ProviderEvent);

      const runtimeEvent = yield* Fiber.join(eventFiber);
      assert.equal(runtimeEvent._tag, "Some");
      if (runtimeEvent._tag !== "Some") {
        return;
      }

      assert.equal(runtimeEvent.value.type, "runtime.error");
      assert.deepStrictEqual(runtimeEvent.value.payload, {
        message: "Claude stream overloaded",
        class: "provider_error",
        detail: {
          class: "provider_error",
          nativeType: "overloaded_error",
        },
      });
    }),
  );

  it.effect(
    "maps server tool use and web search result provider events into canonical web_search lifecycle events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* ClaudeCodeAdapter;
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        const createdAt = new Date().toISOString();

        lifecycleManager.emit("event", {
          id: asEventId("evt-web-search-updated"),
          kind: "notification",
          provider: "claudeCode",
          threadId: asThreadId("thread-1"),
          createdAt,
          turnId: asTurnId("turn-3"),
          itemId: ProviderItemId.makeUnsafe("srvtoolu_1"),
          method: "item/tool/updated",
          payload: {
            item: {
              type: "server_tool_use",
              toolName: "web_search",
              input: {
                query: "weather nyc",
              },
              summary: "weather nyc",
            },
          },
        } satisfies ProviderEvent);

        lifecycleManager.emit("event", {
          id: asEventId("evt-web-search-completed"),
          kind: "notification",
          provider: "claudeCode",
          threadId: asThreadId("thread-1"),
          createdAt,
          turnId: asTurnId("turn-3"),
          itemId: ProviderItemId.makeUnsafe("srvtoolu_1"),
          method: "item/tool/completed",
          payload: {
            item: {
              type: "web_search_tool_result",
              toolName: "web_search",
              status: "completed",
              input: {
                query: "weather nyc",
              },
              result: [
                {
                  type: "web_search_result",
                  title: "Weather in NYC - Example",
                  url: "https://example.com/weather",
                },
              ],
              summary: "Weather in NYC - Example",
            },
          },
        } satisfies ProviderEvent);

        const runtimeEvents = Array.from(yield* Fiber.join(eventFiber));

        assert.equal(runtimeEvents.length, 2);
        assert.equal(runtimeEvents[0]?.type, "item.updated");
        assert.equal(runtimeEvents[0]?.itemId, RuntimeItemId.makeUnsafe("srvtoolu_1"));
        assert.deepStrictEqual(runtimeEvents[0]?.raw, {
          source: "claude-code.stream-json",
          method: "item/tool/updated",
          payload: {
            item: {
              type: "server_tool_use",
              toolName: "web_search",
              input: {
                query: "weather nyc",
              },
              summary: "weather nyc",
            },
          },
        });
        assert.deepStrictEqual(runtimeEvents[0]?.payload, {
          itemType: "web_search",
          status: "inProgress",
          title: "web_search",
          detail: "weather nyc",
          data: {
            item: {
              type: "server_tool_use",
              toolName: "web_search",
              input: {
                query: "weather nyc",
              },
              summary: "weather nyc",
            },
          },
        });

        assert.equal(runtimeEvents[1]?.type, "item.completed");
        assert.equal(runtimeEvents[1]?.itemId, RuntimeItemId.makeUnsafe("srvtoolu_1"));
        assert.deepStrictEqual(runtimeEvents[1]?.raw, {
          source: "claude-code.stream-json",
          method: "item/tool/completed",
          payload: {
            item: {
              type: "web_search_tool_result",
              toolName: "web_search",
              status: "completed",
              input: {
                query: "weather nyc",
              },
              result: [
                {
                  type: "web_search_result",
                  title: "Weather in NYC - Example",
                  url: "https://example.com/weather",
                },
              ],
              summary: "Weather in NYC - Example",
            },
          },
        });
        assert.deepStrictEqual(runtimeEvents[1]?.payload, {
          itemType: "web_search",
          status: "completed",
          title: "web_search",
          detail: "Weather in NYC - Example",
          data: {
            item: {
              type: "web_search_tool_result",
              toolName: "web_search",
              status: "completed",
              input: {
                query: "weather nyc",
              },
              result: [
                {
                  type: "web_search_result",
                  title: "Weather in NYC - Example",
                  url: "https://example.com/weather",
                },
              ],
              summary: "Weather in NYC - Example",
            },
          },
        });
      }),
  );
});