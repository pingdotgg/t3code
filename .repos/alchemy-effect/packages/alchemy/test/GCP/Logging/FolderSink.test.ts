import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
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
const destinationOf = (project: string) =>
  `logging.googleapis.com/projects/${project}/locations/global/buckets/_Default`;

const waitUntilGone = (name: string) =>
  logging.getFoldersSinks({ sinkName: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a folder logging sink",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSink("Errors", {
            destination: destinationOf(project),
            filter: "severity>=ERROR",
            description: "application errors",
          });
        }),
      );

      expect(created.sinkId).toEqual(expect.any(String));
      expect(created.parent).toEqual(`projects/${project}`);
      expect(created.name).toEqual(
        `projects/${project}/sinks/${created.sinkId}`,
      );
      expect(created.destination).toEqual(destinationOf(project));
      expect(created.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("application errors");
      expect(created.disabled).toEqual(false);

      const fetched = yield* logging.getFoldersSinks({
        sinkName: created.name,
      });
      expect(fetched.destination).toEqual(destinationOf(project));
      expect(fetched.filter).toEqual("severity>=ERROR");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("application errors");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSink("Errors", {
            sinkId: created.sinkId,
            destination: destinationOf(project),
            filter: "severity>=WARNING",
            description: "warnings and errors",
            disabled: true,
            exclusions: [
              {
                name: "drop-healthchecks",
                filter: 'httpRequest.requestUrl="/healthz"',
                description: "skip probes",
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual("severity>=WARNING");
      expect(updated.description).toEqual("warnings and errors");
      expect(updated.disabled).toEqual(true);
      expect(updated.exclusions).toEqual([
        expect.objectContaining({
          name: "drop-healthchecks",
          filter: 'httpRequest.requestUrl="/healthz"',
        }),
      ]);

      const last = created.sinkId.at(-1) ?? "a";
      const nextSinkId = `${created.sinkId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.FolderSink("Errors", {
            sinkId: nextSinkId,
            destination: destinationOf(project),
            filter: "severity>=WARNING",
            description: "replaced sink",
          });
        }),
      );

      expect(replaced.sinkId).not.toEqual(created.sinkId);
      expect(replaced.description).toEqual("replaced sink");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
