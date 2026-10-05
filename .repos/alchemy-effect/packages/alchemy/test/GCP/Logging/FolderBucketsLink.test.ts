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
  logging.getFoldersLocationsBucketsLinks({ name }).pipe(
    Effect.map((link) =>
      link.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getFoldersLocationsBucketsLinks on a missing link fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getFoldersLocationsBucketsLinks({
          name: `projects/${project}/locations/global/buckets/_Default/links/alchemy-does-not-exist`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "create and delete a folder logging bucket link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.LogBucket("FolderLinkBucket", {
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.FolderBucketsLink("FolderLink", {
            bucketName: bucket.name,
            description: "bigquery analytics",
          });
          return { bucket, link };
        }),
      );

      expect(created.link.linkId).toEqual(expect.any(String));
      expect(created.link.linkId).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(created.link.bucketName).toEqual(created.bucket.name);
      expect(created.link.name).toEqual(
        `${created.bucket.name}/links/${created.link.linkId}`,
      );
      expect(created.link.description).toEqual("bigquery analytics");
      expect(["ACTIVE", "CREATING"]).toContain(created.link.lifecycleState);

      const fetched = yield* logging.getFoldersLocationsBucketsLinks({
        name: created.link.name,
      });
      expect(fetched.name).toEqual(created.link.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("bigquery analytics");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.link.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 180_000 },
);
