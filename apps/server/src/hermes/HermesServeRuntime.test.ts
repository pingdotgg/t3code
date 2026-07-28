import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DEFAULT_HERMES_SERVE_ENDPOINT,
  makeHermesServeRuntime,
  resolveHermesServeEndpoint,
} from "./HermesServeRuntime.ts";

describe("HermesServeRuntime", () => {
  it("uses the standard loopback gateway when no endpoint is configured", () => {
    assert.equal(resolveHermesServeEndpoint(""), DEFAULT_HERMES_SERVE_ENDPOINT);
    assert.equal(
      resolveHermesServeEndpoint(" ws://127.0.0.1:19119/api/ws "),
      "ws://127.0.0.1:19119/api/ws",
    );
  });

  it.effect("attaches to an already-running compatible Hermes gateway", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0;
        const runtime = yield* makeHermesServeRuntime({
          endpoint: "",
          authToken: "shared-token",
          managedServerEnabled: true,
          processEnvironment: {},
          probe: async () => undefined,
          endpointReachable: async () => true,
          start: () => {
            starts += 1;
            return Effect.succeed({
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
            });
          },
        });

        const connection = yield* runtime.ensureReady;
        assert.equal(connection.endpoint, DEFAULT_HERMES_SERVE_ENDPOINT);
        assert.equal(connection.ownership, "external");
        assert.equal(starts, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts and owns Hermes Serve only when no endpoint is listening", () =>
    Effect.gen(function* () {
      let ready = false;
      let starts = 0;
      let kills = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeHermesServeRuntime({
            endpoint: "ws://127.0.0.1:19119/api/ws",
            authToken: "managed-token",
            managedServerEnabled: true,
            processEnvironment: {},
            startupPollInterval: "1 millis",
            probe: async () => {
              if (!ready) throw new Error("not ready");
            },
            endpointReachable: async () => false,
            start: () => {
              starts += 1;
              ready = true;
              return Effect.succeed({
                isRunning: Effect.succeed(true),
                kill: () =>
                  Effect.sync(() => {
                    kills += 1;
                  }),
              });
            },
          });

          const connection = yield* runtime.ensureReady;
          assert.equal(connection.ownership, "t3_owned");
          assert.equal(starts, 1);
          assert.equal(runtime.currentOwnership(), "t3_owned");
        }),
      );
      assert.equal(kills, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace a reachable gateway that rejects the configured token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0;
        const runtime = yield* makeHermesServeRuntime({
          endpoint: "",
          authToken: "wrong-token",
          managedServerEnabled: true,
          processEnvironment: {},
          probe: async () => {
            throw new Error("unauthorized");
          },
          endpointReachable: async () => true,
          start: () => {
            starts += 1;
            return Effect.succeed({
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
            });
          },
        });

        const result = yield* Effect.result(runtime.ensureReady);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(result.failure.message, "already running");
        }
        assert.equal(starts, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops a lingering owned process before launching a replacement", () =>
    Effect.gen(function* () {
      let starts = 0;
      let kills = 0;
      let healthy = false;
      let processListening = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeHermesServeRuntime({
            endpoint: "ws://127.0.0.1:19122/api/ws",
            authToken: "managed-token",
            managedServerEnabled: true,
            processEnvironment: {},
            startupPollInterval: "1 millis",
            probe: async () => {
              if (!healthy) throw new Error("not ready");
            },
            endpointReachable: async () => processListening,
            start: () => {
              starts += 1;
              healthy = true;
              processListening = true;
              return Effect.succeed({
                isRunning: Effect.succeed(true),
                kill: () =>
                  Effect.sync(() => {
                    kills += 1;
                  }),
              });
            },
          });

          const first = yield* runtime.ensureReady;
          assert.equal(first.ownership, "t3_owned");
          assert.equal(starts, 1);

          // The managed child stays alive but its TCP listener drops, so the
          // endpoint reads as unreachable while the old process still runs.
          healthy = false;
          processListening = false;
          const second = yield* runtime.ensureReady;
          assert.equal(second.ownership, "t3_owned");
          assert.equal(starts, 2);
          assert.equal(kills, 1);
        }),
      );
      assert.equal(kills, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("relaunches its own unhealthy managed process rather than reporting a conflict", () =>
    Effect.gen(function* () {
      let starts = 0;
      let kills = 0;
      let healthy = false;
      let processListening = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeHermesServeRuntime({
            endpoint: "ws://127.0.0.1:19121/api/ws",
            authToken: "managed-token",
            managedServerEnabled: true,
            processEnvironment: {},
            startupPollInterval: "1 millis",
            probe: async () => {
              if (!healthy) throw new Error("not ready");
            },
            endpointReachable: async () => processListening,
            start: () => {
              starts += 1;
              healthy = true;
              processListening = true;
              return Effect.succeed({
                isRunning: Effect.succeed(true),
                kill: () =>
                  Effect.sync(() => {
                    kills += 1;
                    processListening = false;
                  }),
              });
            },
          });

          const first = yield* runtime.ensureReady;
          assert.equal(first.ownership, "t3_owned");
          assert.equal(starts, 1);

          // The managed child keeps its socket open but stops answering probes.
          healthy = false;
          const second = yield* runtime.ensureReady;
          assert.equal(second.ownership, "t3_owned");
          assert.equal(starts, 2);
          assert.equal(kills, 1);
        }),
      );
      assert.equal(kills, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
