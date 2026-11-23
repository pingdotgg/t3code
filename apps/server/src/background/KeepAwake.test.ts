import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Settings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

describe("KeepAwake.holdWhileWanted", () => {
  it.effect("keeps one hold across a gap shorter than the grace and releases after it", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
        Effect.forkScoped,
      );

      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );
});

describe("KeepAwake.layer", () => {
  it.effect("skips the sleep inhibitor when Linux has no system bus", () =>
    Effect.gen(function* () {
      const busSocket = "/run/dbus/system_bus_socket";
      const exists = vi.fn((path: string) =>
        path === busSocket ? Effect.succeed(false) : Effect.succeed(true),
      );

      yield* Layer.build(KeepAwake.layer).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.mock(FileSystem.FileSystem)({
              readFileString: () => Effect.succeed("Linux"),
              exists,
            }),
            // The services below are only needed past the skip; die-if-touched proves we stop early.
            Layer.mock(Settings.ServerSettingsService)({}),
            Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
            Layer.mock(SqlClient.SqlClient)({}),
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
          ),
        ),
      );

      expect(exists).toHaveBeenCalledWith(busSocket);
    }),
  );
});
