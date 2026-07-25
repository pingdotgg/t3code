import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";

it.effect(
  "publishes lifecycle events without subscribers and snapshots the latest welcome/ready",
  () =>
    Effect.gen(function* () {
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const environment = {
        environmentId: EnvironmentId.make("environment-test"),
        label: "Test environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      };

      const welcome = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            cwd: "/tmp/project",
            projectName: "project",
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(welcome));
      assert.equal(welcome.value.sequence, 1);

      const ready = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "ready",
          payload: {
            at: "2026-01-01T00:00:00.000Z",
            environment,
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(ready));
      assert.equal(ready.value.sequence, 2);

      const serviceUpdate = yield* lifecycleEvents.publish({
        version: 1,
        type: "serviceUpdate",
        payload: {
          status: "draining",
          targetVersion: "0.0.29",
          activeTurnCount: 2,
          queuedTurnCount: 0,
          queuedTurns: [],
          startedAt: "2026-07-25T13:23:25.000Z",
        },
      });
      assert.equal(serviceUpdate.sequence, 3);

      const snapshot = yield* lifecycleEvents.snapshot;
      assert.equal(snapshot.sequence, 3);
      assert.deepEqual(snapshot.events.map((event) => event.type).toSorted(), [
        "ready",
        "serviceUpdate",
        "welcome",
      ]);
    }).pipe(Effect.provide(ServerLifecycleEvents.layer)),
);
