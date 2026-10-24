// @effect-diagnostics-next-line nodeBuiltinImport:off - The fixture rejects real SDK requests at the HTTP authentication boundary.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OpenCodeSettings } from "../settings.ts";
import { makeOpenCodeAdapterV2 } from "./adapter.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const decodeSettings = Schema.decodeSync(OpenCodeSettings);

it.live.each([true, false])("opens an authenticated OpenCode session (external=%s)", (external) =>
  Effect.gen(function* () {
    const password = external ? "settings-password" : "environment-password";
    const requests: string[] = [];
    let eventConnected!: () => void;
    const eventRequest = new Promise<void>((resolve) => {
      eventConnected = resolve;
    });
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof NodeHttp.createServer>>((resolve) => {
            const server = NodeHttp.createServer((request, response) => {
              if (
                request.headers.authorization !==
                `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
              ) {
                response.writeHead(401).end("Unauthorized");
                return;
              }
              const url = new URL(request.url!, "http://localhost");
              requests.push(url.pathname);
              if (url.pathname === "/event") {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.write(": connected\n\n");
                eventConnected();
                return;
              }
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify(
                  url.pathname.endsWith("/children")
                    ? []
                    : url.pathname === "/session"
                      ? { id: "native-auth", time: { created: 1, updated: 1 } }
                      : { healthy: true, version: "1.14.19" },
                ),
              );
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    const address = server.address();
    assert.isNotNull(address);
    if (!address || typeof address === "string") return;
    const url = `http://127.0.0.1:${address.port}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let managedStarts = 0;
    const runtimeLayer = OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            assert.isTrue(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
            assert.include(command.args, "serve");
            assert.equal(command.options.env?.OPENCODE_SERVER_PASSWORD, password);
            managedStarts += 1;
            // Keep the real startup parser and process cleanup, replacing only the provider binary.
            return spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "-e",
                  `console.log("server listening on " + process.argv[1]); setInterval(() => {}, 1000)`,
                  url,
                ],
                command.options,
              ),
            );
          }),
        ),
      ),
      Layer.provide(OpenCodeServerLedger.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const instanceId = ProviderInstanceId.make("opencode-auth");
    const adapter = yield* makeOpenCodeAdapterV2({
      instanceId,
      settings: decodeSettings({
        serverUrl: external ? url : "",
        ...(external ? { serverPassword: password } : {}),
      }),
      environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
    }).pipe(Effect.provide(runtimeLayer));
    const session = yield* adapter.openSession({
      threadId: ThreadId.make("thread-opencode-auth"),
      providerSessionId: ProviderSessionId.make("session-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    yield* session.ensureThread({
      threadId: ThreadId.make("thread-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    assert.equal(session.providerSessionId, "session-opencode-auth");
    assert.include(requests, "/session");
    yield* Effect.promise(() => eventRequest);
    assert.include(requests, "/event");
    assert.include(requests, "/global/health");
    assert.equal(managedStarts, external ? 0 : 1);
  }).pipe(
    Effect.scoped,
    Effect.provide([
      NodeServices.layer,
      TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      IdAllocator.layer,
      McpProviderSessions.layer,
    ]),
  ),
);
