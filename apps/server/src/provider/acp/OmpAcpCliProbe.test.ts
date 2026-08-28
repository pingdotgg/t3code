/**
 * Optional integration check against a real `omp acp` install.
 * Enable with: T3_OMP_ACP_PROBE=1 bun run test --filter OmpAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe.runIf(process.env.T3_OMP_ACP_PROBE === "1")("OMP ACP CLI probe", () => {
  it.effect("initialize, authenticate, and create a session against real omp acp", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult.agentInfo?.name).toBe("oh-my-pi");
      expect(started.sessionId).toBeTruthy();

      const setup = started.sessionSetupResult;
      if ("sessionId" in setup) {
        expect(setup.sessionId).toBe(started.sessionId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: "omp",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-probe", version: "0.0.0" },
          authMethodId: "agent",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
