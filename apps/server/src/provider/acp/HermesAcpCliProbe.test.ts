/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 vp test run HermesAcpCliProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeHermesAcpRuntime } from "./HermesAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeHermesAcpRuntime({
    hermesSettings: {
      binaryPath: process.env.T3_HERMES_BINARY ?? "hermes",
      homePath: process.env.T3_HERMES_HOME ?? "",
      authMethodId: process.env.T3_HERMES_AUTH_METHOD ?? "",
    },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
    requestLogger: (event) => Console.log("Hermes ACP request", event),
    protocolLogging: {
      logIncoming: true,
      logOutgoing: true,
      logger: (event) => Console.log("Hermes ACP protocol", event),
    },
  });
});

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes ACP CLI probe", () => {
  it.effect("initializes, authenticates, and creates a Hermes session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
