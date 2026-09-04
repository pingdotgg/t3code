// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makePiRpcClient } from "./PiRpcClient.ts";
import { isPiRpcAgentSettledEvent, isPiRpcExtensionUIRequest } from "./PiRpcProtocol.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "testFixtures/pi-rpc-mock-agent.mjs");

describe("PiRpcClient", () => {
  it.effect("correlates responses while publishing interleaved events", () =>
    Effect.gen(function* () {
      const client = yield* makePiRpcClient({
        binaryPath: "node",
        args: [mockAgentPath],
        cwd: process.cwd(),
      });
      const firstEvent = yield* client.events.pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      const state = yield* client.request({ type: "get_state" });

      expect(state).toMatchObject({
        command: "get_state",
        success: true,
        data: { sessionId: "mock-session" },
      });
      expect((yield* Fiber.join(firstEvent))._tag).toBe("Some");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("round-trips extension dialogs and streams through agent settlement", () =>
    Effect.gen(function* () {
      const client = yield* makePiRpcClient({
        binaryPath: "node",
        args: [mockAgentPath],
        cwd: process.cwd(),
      });
      const dialog = yield* Deferred.make<string>();
      const settled = yield* Deferred.make<void>();
      yield* client.events.pipe(
        Stream.runForEach((event) => {
          if (isPiRpcExtensionUIRequest(event) && event.method === "confirm") {
            return Deferred.succeed(dialog, event.id);
          }
          if (isPiRpcAgentSettledEvent(event)) {
            return Deferred.succeed(settled, undefined);
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );

      expect(yield* client.request({ type: "prompt", message: "hello" })).toMatchObject({
        command: "prompt",
        success: true,
      });
      const dialogId = yield* Deferred.await(dialog);
      yield* client.send({ type: "extension_ui_response", id: dialogId, confirmed: true });
      yield* Deferred.await(settled);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails later operations after an unexpected child exit", () =>
    Effect.gen(function* () {
      const client = yield* makePiRpcClient({
        binaryPath: "node",
        args: [mockAgentPath],
        cwd: process.cwd(),
      });
      yield* client.request({ type: "prompt", message: "exit" });
      const failure = yield* client.awaitFailure.pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PiRpcClientError", operation: "process-exit" });
      expect(yield* client.request({ type: "abort" }).pipe(Effect.flip)).toBe(failure);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
