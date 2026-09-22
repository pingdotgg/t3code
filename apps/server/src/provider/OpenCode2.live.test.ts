// @effect-diagnostics nodeBuiltinImport:off - The mock model is a real HTTP peer of a native executable.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { IdAllocatorV2, layer as idsLayer } from "../orchestration-v2/IdAllocator.ts";
import * as Adapter from "../orchestration-v2/Adapters/OpenCode2Adapter.ts";
import type { OpenCodeClient } from "@opencode/client";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";
import * as Native from "./OpenCode2Client.ts";
import * as Generation from "../textGeneration/OpenCode2Generation.ts";
import * as Inventory from "./OpenCode2Inventory.ts";

const layer = Layer.mergeAll(OpenCodeRuntimeLive, idsLayer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const withServer = Effect.fn("OpenCode2Test.withServer")(function* <A, E, R>(
  config: unknown,
  use: (client: OpenCodeClient, directory: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-opencode2-" })
    .pipe(Effect.flatMap(fs.realPath));
  const runtime = yield* OpenCodeRuntime;
  const server = yield* runtime.startOpenCodeServerProcess({
    binaryPath: process.env.OPENCODE_TEST_BINARY!,
    directory: root,
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_CONFIG_CONTENT: encodeJson(config),
    },
  });
  expect(server.version).toMatch(/^2\./);
  expect(server.serverPassword).toBeTruthy();
  return yield* use(Native.make(server), root);
});

function configuration(baseURL: string) {
  return {
    model: "audit/test",
    agents: { build: { permissions: [{ action: "shell", resource: "*", effect: "allow" }] } },
    providers: {
      audit: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "fixture" },
        models: {
          test: {
            name: "Fixture",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 32000, output: 1000 },
          },
        },
      },
    },
  };
}

// Explicit opt-in: all state belongs to this test; the user's service is never discovered.
it.live.runIf(Boolean(process.env.OPENCODE_TEST_BINARY))(
  "released OpenCode startup, authenticated inventory, session permissions and cursors",
  () =>
    withServer(configuration("http://127.0.0.1:9/v1"), (client, root) =>
      Effect.gen(function* () {
        const inventory = yield* Inventory.load(client, root);
        expect(inventory.models.some((model) => model.slug === "audit/test")).toBe(true);
        const session = yield* Native.request("session.create", (signal) =>
          client.session.create({ location: { directory: root }, agent: "build" }, { signal }),
        );
        const permission = () =>
          Native.request("permission.create", (signal) =>
            client.permission.create(
              {
                sessionID: session.id,
                action: "shell",
                resources: ["printf audit"],
                agent: "build",
              },
              { signal },
            ),
          );
        expect((yield* permission()).effect).toBe("allow");
        yield* Native.request("session.update", (signal) =>
          client.session.update(
            { sessionID: session.id, permissions: Native.sessionRules("approval-required") },
            { signal },
          ),
        );
        const ask = yield* permission();
        expect(ask.effect).toBe("ask");
        yield* Native.request("permission.reply", (signal) =>
          client.permission.reply(
            { sessionID: session.id, requestID: ask.id, decision: "reject" },
            { signal },
          ),
        );
        yield* Native.request("session.update", (signal) =>
          client.session.update(
            {
              sessionID: session.id,
              permissions: [{ action: "*", resource: "*", effect: "deny" }],
            },
            { signal },
          ),
        );
        expect((yield* permission()).effect).toBe("deny");
        yield* Native.request("session.switchAgent", (signal) =>
          client.session.switchAgent({ sessionID: session.id, agent: "plan" }, { signal }),
        );
        yield* Native.request("session.switchAgent", (signal) =>
          client.session.switchAgent({ sessionID: session.id, agent: "build" }, { signal }),
        );
        const first = yield* Native.request("message.list", (signal) =>
          client.message.list({ sessionID: session.id, limit: 1, order: "asc" }, { signal }),
        );
        expect(first.cursor.next).toBeTruthy();
        const invalid = yield* Native.request("message.list", (signal) =>
          client.message.list(
            { sessionID: session.id, limit: 1, order: "asc", cursor: first.cursor.next! },
            { signal },
          ),
        ).pipe(Effect.exit);
        expect(invalid._tag).toBe("Failure");
        const history = yield* Native.messages(client, session.id);
        expect(history.filter((message) => message.type === "agent-switched")).toHaveLength(2);
        const fork = yield* Native.request("session.fork", (signal) =>
          client.session.fork({ sessionID: session.id, before: history[1]!.id }, { signal }),
        );
        expect(
          (yield* Native.messages(client, fork.id)).filter(
            (message) => message.type === "agent-switched",
          ),
        ).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const destination = path.join(root, "fork-workspace");
        yield* fs.makeDirectory(destination);
        yield* Native.request("session.move", (signal) =>
          client.session.move({ sessionID: fork.id, directory: destination }, { signal }),
        );
        yield* Native.request("session.wait", (signal) =>
          client.session.wait({ sessionID: fork.id }, { signal }),
        );
        expect(
          (yield* Native.request("session.get", (signal) =>
            client.session.get({ sessionID: fork.id }, { signal }),
          )).location.directory,
        ).toBe(destination);
      }),
    ).pipe(Effect.provide(layer)),
  30_000,
);

it.live.runIf(Boolean(process.env.OPENCODE_TEST_BINARY))(
  "released OpenCode performs tool-free workspace generation against a local model",
  () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = [];
      const model = NodeHttp.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        requests.push(decodeRequest(raw));
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "fixture response" },
              finish_reason: null,
            },
          ],
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${encodeJson(chunk)}\n\ndata: ${encodeJson({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        );
      });
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                model.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
      );
      const address = model.address();
      if (!address || typeof address === "string")
        return yield* Effect.die("Mock model did not bind TCP");
      yield* withServer(configuration(`http://127.0.0.1:${address.port}/v1`), (client, root) =>
        Effect.gen(function* () {
          const result = yield* Generation.generate(client, {
            cwd: root,
            model: { providerID: "audit", id: "test" },
            agent: "build",
            prompt: "Reply with a short title.",
            files: [],
          });
          expect(result).toBe("fixture response");
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.every(
              (request) =>
                !request.tools || (Array.isArray(request.tools) && request.tools.length === 0),
            ),
          ).toBe(true);
          const instanceId = ProviderInstanceId.make("native-live");
          const threadId = ThreadId.make("native-live-thread");
          const modelSelection = { instanceId, model: "audit/test", options: [] };
          const runtimePolicy = {
            cwd: root,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
          };
          const adapter = Adapter.make({
            instanceId,
            connect: Effect.succeed(client),
            idAllocator: yield* IdAllocatorV2,
            fileSystem: yield* FileSystem.FileSystem,
            serverConfig: { cwd: root, attachmentsDir: root },
          });
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("native-live-session"),
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const at = yield* DateTime.now;
          const received = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* runtime.startTurn({
            threadId,
            providerThread,
            modelSelection,
            runtimePolicy,
            runId: RunId.make("live-run"),
            attemptId: RunAttemptId.make("live-attempt"),
            rootNodeId: NodeId.make("live-root"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            message: {
              messageId: MessageId.make("live-message"),
              text: "Reply briefly.",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            appThread: {
              id: threadId,
              projectId: ProjectId.make("live-project"),
              title: "Live native test",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: at,
              updatedAt: at,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          const events = yield* Fiber.join(received);
          expect(
            events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "fixture response" &&
                !event.message.streaming,
            ),
          ).toBe(true);
          expect(events.find((event) => event.type === "turn.terminal")?.status).toBe("completed");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const image = path.join(root, "pixel.gif");
          yield* fs.writeFile(
            image,
            Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
          );
          expect(
            yield* Generation.generate(client, {
              cwd: root,
              model: { providerID: "audit", id: "test" },
              agent: "build",
              prompt: "Describe the attached image.",
              files: [{ uri: NodeURL.pathToFileURL(image).href }],
            }),
          ).toBe("fixture response");
          expect(
            requests.some((request) => encodeJson(request).includes('"type":"image_url"')),
          ).toBe(true);
        }),
      );
    }).pipe(Effect.provide(layer)),
  30_000,
);
