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

const waitUntilGone = (name: string) =>
  logging.getLocationsBuckets({ name }).pipe(
    Effect.map((bucket) =>
      bucket.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a locations logging bucket",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LocationsBucket("AppLogs", {
            description: "application logs",
            retentionDays: 31,
          });
        }),
      );

      expect(created.bucketId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.parent).toEqual(`projects/${project}`);
      expect(created.name).toEqual(
        `projects/${project}/locations/global/buckets/${created.bucketId}`,
      );
      expect(created.description).toEqual("application logs");
      expect(created.retentionDays).toEqual(31);
      expect(created.lifecycleState).toEqual("ACTIVE");

      const fetched = yield* logging.getLocationsBuckets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.retentionDays).toEqual(31);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("application logs");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LocationsBucket("AppLogs", {
            bucketId: created.bucketId,
            location: created.location,
            description: "retained application logs",
            retentionDays: 60,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("retained application logs");
      expect(updated.retentionDays).toEqual(60);

      const last = created.bucketId.at(-1) ?? "a";
      const nextBucketId = `${created.bucketId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LocationsBucket("AppLogs", {
            bucketId: nextBucketId,
            location: "global",
            description: "replaced bucket",
            retentionDays: 31,
          });
        }),
      );

      expect(replaced.bucketId).not.toEqual(created.bucketId);
      expect(replaced.description).toEqual("replaced bucket");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
