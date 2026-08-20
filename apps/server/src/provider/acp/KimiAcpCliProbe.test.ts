/**
 * Optional non-billing integration check against a real `kimi acp` install.
 * Enable with: T3_KIMI_ACP_PROBE=1 pnpm exec vp test run KimiAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKimiAcpRuntime } from "./KimiAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeKimiAcpRuntime({
    kimiSettings: { binaryPath: "kimi", launchArgs: "" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-kimi-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI probe", () => {
  it.effect("initializes, authenticates, and opens a throwaway ACP session without prompting", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
