import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  datalineage.getProjectsLocationsProcessesRunsLineageEvents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create and delete a lineage event",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const process = yield* GCP.DataLineage.Process("Etl", {
            location: "us-central1",
            displayName: "event parent",
            attributes: { env: "test" },
          });
          const run = yield* GCP.DataLineage.ProcessesRun("Nightly", {
            process: process.name,
            startTime: "2024-01-01T00:00:00Z",
            state: "STARTED",
            attributes: { env: "test" },
          });
          const event = yield* GCP.DataLineage.ProcessesRunsLineageEvent(
            "Load",
            {
              run: run.name,
              startTime: "2024-01-01T00:00:00Z",
              endTime: "2024-01-01T00:05:00Z",
              links: [
                {
                  source: {
                    fullyQualifiedName: `custom:${project}.raw.orders`,
                  },
                  target: {
                    fullyQualifiedName: `custom:${project}.dw.orders`,
                  },
                },
              ],
            },
          );
          return { process, run, event };
        }),
      );

      expect(created.event.name).toContain("/lineageEvents/");
      expect(created.event.lineageEventId).toEqual(expect.any(String));
      expect(created.event.run).toEqual(created.run.name);
      expect(created.event.process).toEqual(created.process.name);
      expect(created.event.links.length).toEqual(1);
      expect(created.event.links[0]?.source.fullyQualifiedName).toContain(
        "raw.orders",
      );
      expect(created.event.links[0]?.target.fullyQualifiedName).toContain(
        "dw.orders",
      );

      const fetched =
        yield* datalineage.getProjectsLocationsProcessesRunsLineageEvents({
          name: created.event.name,
        });
      expect(fetched.name).toEqual(created.event.name);
      expect(fetched.links?.length).toEqual(1);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.event.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalineage", "live"],
    timeout: 90_000,
  },
);
