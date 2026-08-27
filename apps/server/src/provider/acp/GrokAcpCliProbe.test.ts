/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with: T3_GROK_ACP_PROBE=1 vp test run GrokAcpCliProbe
 * Set T3_GROK_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // Modern grok-shell advertises models through the typed
      // `SessionModelState` field, not via a `configOptions` entry.
      // If this assertion fails the upstream surface has regressed.
      const models = result.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts advertised reasoning effort metadata", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const modelState = started.sessionSetupResult.models;
      const currentModelId = modelState?.currentModelId.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      const currentModel = modelState?.availableModels.find(
        (model) => model.modelId.trim() === currentModelId,
      );
      const reasoningEffort = currentModel?._meta?.reasoningEffort;
      expect(typeof reasoningEffort).toBe("string");
      if (typeof reasoningEffort !== "string") return;

      yield* runtime.setSessionModel(currentModelId, { reasoningEffort });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_GROK_LIVE_TURN !== "1")(
    "finishes a real Grok turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const runtime = yield* makeGrokAcpRuntime({
          grokSettings: { binaryPath: "grok" },
          environment: process.env,
          childProcessSpawner,
          cwd,
          runtimeMode: "approval-required",
          clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
        });
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") {
            chunks.push(event.text);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply exactly GROK_T3_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("GROK_T3_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
