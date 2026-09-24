import * as NodeAssert from "node:assert/strict";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./Layers/OpenCodeAdapter.ts";

// Opt in with T3_TEST_OPENCODE_V2_BINARY=/path/to/opencode. All model calls stay on loopback.
const binaryPath = process.env.T3_TEST_OPENCODE_V2_BINARY;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const reply = "## Objective\nFixture reply";
const fixture = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = (yield* request.json) as { messages: Array<{ role: string; content?: unknown }> };
  const callsTool =
    body.messages.some((message) => message.role === "user" && message.content === "Run fixture") &&
    !body.messages.some((message) => message.role === "tool");
  const delta = callsTool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: { name: "shell", arguments: '{"command":"printf fixture"}' },
          },
        ],
      }
    : { content: reply };
  const chunk = (delta: unknown, finish_reason: string | null) =>
    `data: ${encodeJson({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return HttpServerResponse.text(
    chunk(delta, null) + chunk({}, callsTool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
    { contentType: "text/event-stream" },
  );
});

async function untilIdle(
  stream: AsyncIterator<OpenCodeEvent>,
  client: OpenCodeClient,
  sessionID: string,
) {
  const events: OpenCodeEvent[] = [];
  for (;;) {
    const next = await stream.next();
    NodeAssert.ok(!next.done, "event stream ended before the turn completed");
    const event = next.value;
    events.push(event);
    if (event.type === "permission.asked") {
      await client.permission.reply({
        sessionID: event.data.sessionID,
        requestID: event.data.id,
        decision: "once",
      });
    }
    if (event.type === "session.execution.failed") throw new Error(event.data.error.message);
    if (event.type === "session.execution.succeeded" && event.data.sessionID === sessionID)
      return events;
  }
}

describe.runIf(Boolean(binaryPath))("OpenCode v2 native API", () => {
  it.live("runs chat, approval, fork and compaction against the installed binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-native-" });
      const workspace = path.join(root, "workspace");
      yield* fs.makeDirectory(workspace);
      const http = yield* HttpServer.HttpServer;
      yield* http.serve(fixture);
      const runtime = yield* OpenCodeRuntime;
      const server = yield* runtime.connectToOpenCodeServer({
        binaryPath: binaryPath!,
        directory: workspace,
        environment: {
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          OPENCODE_CONFIG_CONTENT: encodeJson({
            update: "disable",
            providers: {
              fixture: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  apiKey: "fixture-key",
                  baseURL: HttpServer.formatAddress(http.address),
                },
                models: {
                  chat: {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: { input: 0, output: 0 },
                    limit: { context: 1_000_000, output: 4000 },
                  },
                },
              },
            },
          }),
        },
      });
      const client = runtime.createOpenCodeSdkClient({
        baseUrl: server.url,
        ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
      });
      const subscription = client.event.subscribe({ signal: AbortSignal.timeout(20_000) });
      const stream = subscription[Symbol.asyncIterator]();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await stream.return?.();
        }),
      );
      NodeAssert.equal(
        (yield* Effect.promise(() => stream.next())).value?.type,
        "server.connected",
      );
      const session = yield* Effect.promise(() =>
        client.session.create({
          title: "Fixture",
          location: { directory: workspace },
          model: { providerID: "fixture", id: "chat" },
          permissions: [{ action: "*", resource: "*", effect: "ask" }],
        }),
      );
      const sessionID = session.id;
      yield* Effect.promise(() =>
        client.session.prompt({ sessionID, id: "msg_fixture", text: "Run fixture" }),
      );
      const events = yield* Effect.promise(() => untilIdle(stream, client, sessionID));
      NodeAssert.ok(events.some((event) => event.type === "permission.asked"));
      NodeAssert.ok(events.some((event) => event.type === "session.tool.success"));
      NodeAssert.ok(
        events.some((event) => event.type === "session.text.delta" && event.data.delta === reply),
      );
      const waitSession = yield* Effect.promise(() =>
        client.session.create({
          location: { directory: workspace },
          model: { providerID: "fixture", id: "chat" },
        }),
      );
      yield* Effect.promise(() =>
        client.session.prompt({ sessionID: waitSession.id, text: "Reply without tools" }),
      );
      yield* Effect.promise(() => client.session.wait({ sessionID: waitSession.id }));
      const generated = yield* Effect.promise(() =>
        client.message.list({ sessionID: waitSession.id }),
      );
      NodeAssert.ok(
        generated.data.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text === reply),
        ),
      );
      const history = yield* Effect.promise(() => client.message.list({ sessionID }));
      NodeAssert.ok(history.data.some((message) => message.id === "msg_fixture"));
      const fork = yield* Effect.promise(() =>
        client.session.fork({ sessionID, before: "msg_fixture" }),
      );
      const forkHistory = yield* Effect.promise(() => client.message.list({ sessionID: fork.id }));
      NodeAssert.equal(forkHistory.data.length, 0);
      yield* Effect.promise(() => client.session.compact({ sessionID }));
      yield* Effect.promise(() => client.session.wait({ sessionID }));
      const compaction = yield* Effect.promise(() => untilIdle(stream, client, sessionID));
      NodeAssert.ok(compaction.some((event) => event.type === "session.compaction.ended"));

      const adapter = yield* makeOpenCodeAdapter(
        decodeOpenCodeSettings({
          binaryPath: binaryPath!,
          serverUrl: server.url,
          ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
        }),
      ).pipe(Effect.provide(ServerConfig.layerTest(root, workspace)));
      const threadId = ThreadId.make("opencode-native-adapter");
      const adapterEvents = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(adapterEvents, (events) => [...events, event]);
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(event.requestId),
                "accept",
              );
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        cwd: workspace,
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Run fixture",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "fixture/chat"),
      });
      yield* Fiber.join(eventFiber);
      const emitted = yield* Ref.get(adapterEvents);
      NodeAssert.ok(emitted.some((event) => event.type === "request.opened"));
      NodeAssert.ok(
        emitted.some((event) => event.type === "content.delta" && event.payload.delta === reply),
      );
      NodeAssert.equal(
        emitted.find((event) => event.type === "turn.completed")?.payload.state,
        "completed",
      );
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          NodeHttpServer.layerTest,
        ),
      ),
    ),
  );
});
