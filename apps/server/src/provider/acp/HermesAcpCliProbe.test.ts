/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 vp test run HermesAcpCliProbe
 *
 * Set T3_HERMES_ACP_PROBE_BINARY to run a hermes binary that is not on
 * PATH (a wrapper script that proxies stdio to a remote install works,
 * since ACP is pure stdio).
 *
 * The probe assumes the hermes runtime is already configured with model
 * credentials (`hermes setup`). The prompt turn calls the real model, so
 * it can take tens of seconds.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeHermesAcpRuntime } from "./HermesAcpSupport.ts";

const probeBinaryPath = process.env.T3_HERMES_ACP_PROBE_BINARY || "hermes";

// The session cwd must exist wherever the hermes process actually runs:
// `hermes acp` rejects `session/new` for a nonexistent cwd, and with a
// remote wrapper binary a per-run local temp directory does not exist on
// the remote host. `os.tmpdir()` exists everywhere a local install runs
// and resolves to /tmp on the hosts a POSIX ssh shim targets;
// T3_HERMES_ACP_PROBE_CWD overrides it when that assumption breaks.
const probeCwd = process.env.T3_HERMES_ACP_PROBE_CWD || NodeOS.tmpdir();

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeHermesAcpRuntime({
    hermesSettings: { binaryPath: probeBinaryPath },
    environment: process.env,
    childProcessSpawner,
    cwd: probeCwd,
    clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes ACP CLI probe", () => {
  it.effect("initialize and authenticate against real hermes acp", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Hermes spends a long thinking phase on even trivial prompts, so a real
  // turn regularly exceeds the suite's default test timeout. The probe is
  // env-gated and never runs in CI, so a generous explicit budget is safe.
  it.effect(
    "finishes a real Hermes turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
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
          prompt: [{ type: "text", text: "Reply exactly HERMES_T3_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        // Hermes's thinking-heavy turns don't reliably echo the exact token
        // (unlike the Grok probe) — assert streamed output arrived, not its
        // wording.
        expect(chunks.join("").length).toBeGreaterThan(0);
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    300_000,
  );
});
