/**
 * Optional integration check against a real `kiro-cli acp` install.
 * Enable with: T3_KIRO_ACP_PROBE=1 vp test run KiroAcpCliProbe
 * Set T3_KIRO_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * The probe assumes the user has previously run `kiro-cli login`. Kiro
 * advertises no ACP auth methods, so an unauthenticated CLI fails at
 * `session/new` rather than at an `authenticate` step.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

const makeProbeRuntime = (options?: { readonly trustNoTools?: boolean }) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    return yield* makeKiroAcpRuntime({
      kiroSettings: { binaryPath: "kiro-cli", agent: "" },
      environment: process.env,
      childProcessSpawner,
      cwd,
      ...options,
      clientInfo: { name: "t3-kiro-probe", version: "0.0.0" },
    });
  });

describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro ACP CLI probe", () => {
  it.effect("initializes without authenticate and advertises no auth methods", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      expect(started.initializeResult.authMethods ?? []).toEqual([]);
      expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises a model catalog and accepts session/set_model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      const models = started.sessionSetupResult.models;
      expect(typeof started.sessionId).toBe("string");
      expect(models?.currentModelId).toBe("auto");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(1);
      const alternate = models?.availableModels.find((model) => model.modelId !== "auto");
      expect(alternate).toBeDefined();
      if (!alternate) return;
      yield* runtime.setSessionModel(alternate.modelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_KIRO_LIVE_TURN !== "1")(
    "finishes a real Kiro turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime({ trustNoTools: true });
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
          prompt: [{ type: "text", text: "Reply exactly KIRO_T3_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("KIRO_T3_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
