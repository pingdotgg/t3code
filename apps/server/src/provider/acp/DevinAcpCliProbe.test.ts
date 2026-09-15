/**
 * Optional integration check against a real `devin acp` install.
 * Enable with: T3_DEVIN_ACP_PROBE=1 vp test run DevinAcpCliProbe
 * Set T3_DEVIN_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * The probe assumes `devin auth login` has already run (or WINDSURF_API_KEY
 * is set). It passes `browserAuth: false`, so a signed-out CLI surfaces a
 * failure instead of opening a browser.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { currentDevinModelIdFromSessionSetup, makeDevinAcpRuntime } from "./DevinAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDevinAcpRuntime({
    devinSettings: { binaryPath: "devin" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-devin-probe", version: "0.0.0" },
    browserAuth: false,
  });
});

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("initializes against real devin acp without an authenticate request", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(started.sessionId).toBeTypeOf("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises a model config option with the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      // Devin does not advertise typed SessionModelState; the model catalog
      // rides the `category: "model"` config option. If this fails the
      // upstream surface has regressed.
      const modelOption = (result.configOptions ?? []).find(
        (option) => option.category === "model" || option.id === "model",
      );
      expect(modelOption).toBeDefined();
      expect(modelOption?.type).toBe("select");
      if (modelOption?.type !== "boolean") {
        const values = (modelOption?.options ?? []).flatMap((entry) =>
          "value" in entry ? [entry.value] : (entry.options ?? []).map((nested) => nested.value),
        );
        expect(values.length).toBeGreaterThan(0);
      }
      expect(currentDevinModelIdFromSessionSetup(result)).toBeTypeOf("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("setModel accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = currentDevinModelIdFromSessionSetup(started.sessionSetupResult);
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // Selecting the model the session already runs on must succeed against
      // every Devin build that implements `session/set_config_option`.
      yield* runtime.setModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.runIf(process.env.T3_DEVIN_LIVE_TURN === "1")(
    "sends a live prompt and receives a response",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        yield* runtime.start();
        const deltas: string[] = [];
        yield* Stream.runForEach(runtime.getEvents(), (event) =>
          event._tag === "ContentDelta" ? Effect.sync(() => deltas.push(event.text)) : Effect.void,
        ).pipe(Effect.forkScoped);
        const response = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply with exactly the word: pong" }],
        });
        expect(response.stopReason).toBeDefined();
        expect(deltas.join("")).toContain("pong");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
