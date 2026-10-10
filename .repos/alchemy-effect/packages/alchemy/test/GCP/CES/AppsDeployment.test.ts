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
  ces.getProjectsLocationsAppsDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsDeployments({
          name: `projects/${project}/locations/us/apps/missing/deployments/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete a deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-deployment",
          });
          const version = yield* GCP.CES.AppsVersion("V1", { app: app.name });
          const deployment = yield* GCP.CES.AppsDeployment("Prod", {
            app: app.name,
            appVersion: version.name,
            displayName: "prod",
            channelProfile: { channelType: "API", profileId: "api" },
          });
          return { app, deployment };
        }),
      );

      expect(created.deployment.name).toContain("/deployments/");
      expect(created.deployment.app).toEqual(created.app.name);
      expect(created.deployment.displayName).toEqual("prod");
      expect(created.deployment.channelProfile).toBeDefined();

      const fetched = yield* ces.getProjectsLocationsAppsDeployments({
        name: created.deployment.name,
      });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-deployment",
          });
          const version = yield* GCP.CES.AppsVersion("V1", { app: app.name });
          const deployment = yield* GCP.CES.AppsDeployment("Prod", {
            app: app.name,
            appVersion: version.name,
            deploymentId: created.deployment.deploymentId,
            displayName: "prod-api",
            channelProfile: { channelType: "API", profileId: "api" },
          });
          return { app, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.displayName).toEqual("prod-api");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);
