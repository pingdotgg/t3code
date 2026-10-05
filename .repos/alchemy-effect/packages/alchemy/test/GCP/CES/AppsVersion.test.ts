import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsAppsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsVersions({
          name: `projects/${project}/locations/us/apps/missing/versions/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create and delete an app version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-version",
          });
          const version = yield* GCP.CES.AppsVersion("V1", {
            app: app.name,
            displayName: "v1",
            description: "initial",
          });
          return { app, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.app).toEqual(created.app.name);
      expect(created.version.displayName).toEqual("v1");
      expect(created.version.description).toEqual("initial");

      const fetched = yield* ces.getProjectsLocationsAppsVersions({
        name: created.version.name,
      });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-version",
          });
          const version = yield* GCP.CES.AppsVersion("V1", {
            app: app.name,
            appVersionId: created.version.appVersionId,
            displayName: "v1",
            description: "ignored after create",
          });
          return { app, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.description).toEqual("initial");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);
