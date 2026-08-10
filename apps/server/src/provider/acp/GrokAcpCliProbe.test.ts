/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with: T3_GROK_ACP_PROBE=1 bun run test GrokAcpCliProbe
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { decodeGrokAcpModelReasoningCapabilities, makeGrokAcpRuntime } from "./GrokAcpSupport.ts";
import type { AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";

const makeProbeRuntime = (
  requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeGrokAcpRuntime({
      grokSettings: { binaryPath: "grok" },
      environment: process.env,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
      ...(requestLogger ? { requestLogger } : {}),
    });
  });

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
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
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts the advertised reasoning effort metadata", () =>
    Effect.gen(function* () {
      const requestLog: Array<AcpSessionRequestLogEvent> = [];
      const runtime = yield* makeProbeRuntime((event) =>
        Effect.sync(() => {
          requestLog.push(event);
        }),
      );
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      const model = started.sessionSetupResult.models?.availableModels.find(
        (candidate) => candidate.modelId === currentModelId,
      );
      const reasoning = decodeGrokAcpModelReasoningCapabilities(model);
      const effort =
        reasoning?.options.find((option) => option.value === "low")?.value ??
        reasoning?.options[0]?.value;
      expect(currentModelId).toBeDefined();
      expect(effort).toBeDefined();
      if (!currentModelId || !effort) return;

      yield* runtime.setSessionModel(currentModelId, { reasoningEffort: effort });

      expect(
        requestLog.some(
          (event) =>
            event.method === "session/set_model" &&
            event.status === "started" &&
            event.payload !== null &&
            typeof event.payload === "object" &&
            "_meta" in event.payload &&
            "reasoningEffort" in (event.payload._meta as Record<string, unknown>) &&
            (event.payload._meta as Record<string, unknown>).reasoningEffort === effort,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
