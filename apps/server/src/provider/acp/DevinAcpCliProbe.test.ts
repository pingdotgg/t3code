/**
 * Optional integration check against a real `devin acp` install.
 * Enable with: T3_DEVIN_ACP_PROBE=1 vp test run src/provider/acp/DevinAcpCliProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { discoverDevinModelsViaAcp } from "../Layers/DevinProvider.ts";

const devinLayer = AcpSessionRuntime.layer({
  spawn: {
    command: "devin",
    args: ["acp"],
    cwd: process.cwd(),
  },
  cwd: process.cwd(),
  clientInfo: { name: "t3-probe", version: "0.0.0" },
  authMethodId: "devin-browser",
});

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("initialize and authenticate against real devin acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.provide(devinLayer), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new returns mode and model config options", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const ids = configOptions.map((option) => option.id);
      expect(ids).toContain("mode");
      expect(ids).toContain("model");
      const modeState = yield* runtime.getModeState;
      expect(modeState?.availableModes.map((mode) => mode.id)).toEqual(
        expect.arrayContaining(["accept-edits", "ask", "plan", "bypass"]),
      );
    }).pipe(Effect.provide(devinLayer), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers models through the shared probe runtime", () =>
    Effect.gen(function* () {
      const models = yield* discoverDevinModelsViaAcp({
        enabled: true,
        binaryPath: "devin",
        customModels: [],
      });
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((model) => model.slug === "adaptive")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
