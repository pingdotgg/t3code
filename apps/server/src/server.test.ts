import type { OrchestrationReadModel } from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { recordStartupHeartbeat } from "./server";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

it.effect("records a startup heartbeat with thread/project counts", () =>
  Effect.gen(function* () {
    const recordTelemetry = vi.fn(
      (_event: string, _properties?: Readonly<Record<string, unknown>>) => Effect.void,
    );
    const getSnapshot = vi.fn(() =>
      Effect.succeed({
        snapshotSequence: 2,
        projects: [{} as OrchestrationReadModel["projects"][number]],
        threads: [
          {} as OrchestrationReadModel["threads"][number],
          {} as OrchestrationReadModel["threads"][number],
        ],
        updatedAt: new Date(1).toISOString(),
      } satisfies OrchestrationReadModel),
    );

    yield* recordStartupHeartbeat.pipe(
      Effect.provideService(ProjectionSnapshotQuery, {
        getSnapshot,
      }),
      Effect.provideService(AnalyticsService, {
        record: recordTelemetry,
        flush: Effect.void,
      }),
    );

    assert.deepEqual(recordTelemetry.mock.calls[0], [
      "server.boot.heartbeat",
      {
        threadCount: 2,
        projectCount: 1,
      },
    ]);
  }),
);
