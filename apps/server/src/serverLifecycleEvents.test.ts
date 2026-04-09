import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { Effect, Option } from "effect";

import { ServerLifecycleEvents, ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";

it.effect(
  "publishes lifecycle events without subscribers and snapshots the latest welcome/ready",
  () =>
    Effect.gen(function* () {
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const environment = {
        environmentId: EnvironmentId.makeUnsafe("environment-test"),
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
            at: new Date().toISOString(),
            environment,
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(ready));
      assert.equal(ready.value.sequence, 2);

      const snapshot = yield* lifecycleEvents.snapshot;
      assert.equal(snapshot.sequence, 2);
      assert.deepEqual(snapshot.events.map((event) => event.type).toSorted(), ["ready", "welcome"]);
    }).pipe(Effect.provide(ServerLifecycleEventsLive)),
);
