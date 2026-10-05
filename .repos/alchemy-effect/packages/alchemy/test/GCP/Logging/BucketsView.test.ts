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
  logging.getProjectsLocationsBucketsViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a logging bucket view",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
            description: "view parent",
          });
          const view = yield* GCP.Logging.BucketsView("Stdout", {
            bucket: bucket.name,
            filter: 'LOG_ID("stdout")',
            description: "stdout only",
          });
          return { bucket, view };
        }),
      );

      expect(created.view.viewId).toEqual(expect.any(String));
      expect(created.view.bucket).toEqual(created.bucket.name);
      expect(created.view.project).toEqual(project);
      expect(created.view.location).toEqual("global");
      expect(created.view.name).toEqual(
        `${created.bucket.name}/views/${created.view.viewId}`,
      );
      expect(created.view.filter).toEqual('LOG_ID("stdout")');
      expect(created.view.description).toEqual("stdout only");

      const fetched = yield* logging.getProjectsLocationsBucketsViews({
        name: created.view.name,
      });
      expect(fetched.name).toEqual(created.view.name);
      expect(fetched.filter).toEqual('LOG_ID("stdout")');
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("stdout only");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            description: "view parent",
          });
          const view = yield* GCP.Logging.BucketsView("Stdout", {
            bucket: bucket.name,
            viewId: created.view.viewId,
            filter: 'LOG_ID("stderr")',
            description: "stderr only",
          });
          return { bucket, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.viewId).toEqual(created.view.viewId);
      expect(updated.view.filter).toEqual('LOG_ID("stderr")');
      expect(updated.view.description).toEqual("stderr only");

      const fetchedUpdate = yield* logging.getProjectsLocationsBucketsViews({
        name: created.view.name,
      });
      expect(fetchedUpdate.filter).toEqual('LOG_ID("stderr")');
      expect(fetchedUpdate.description).toContain("stderr only");

      const last = created.view.viewId.at(-1) ?? "a";
      const nextViewId = `${created.view.viewId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            description: "view parent",
          });
          const view = yield* GCP.Logging.BucketsView("Stdout", {
            bucket: bucket.name,
            viewId: nextViewId,
            filter: 'LOG_ID("stderr")',
            description: "replaced view",
          });
          return { bucket, view };
        }),
      );

      expect(replaced.view.viewId).not.toEqual(created.view.viewId);
      expect(replaced.view.name).toEqual(
        `${created.bucket.name}/views/${replaced.view.viewId}`,
      );
      expect(replaced.view.description).toEqual("replaced view");

      const fetchedReplacement =
        yield* logging.getProjectsLocationsBucketsViews({
          name: replaced.view.name,
        });
      expect(fetchedReplacement.name).toEqual(replaced.view.name);

      const previousGone = yield* waitUntilGone(created.view.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
