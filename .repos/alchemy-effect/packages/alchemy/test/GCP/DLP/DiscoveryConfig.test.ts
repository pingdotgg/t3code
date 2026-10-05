import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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

const runLifecycle = !process.env.FAST;

const pausedTarget = () => ({
  cloudStorageTarget: {
    filter: { others: {} },
    disabled: {},
  },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsDiscoveryConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDiscoveryConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsDiscoveryConfigs({
          name: `projects/${project}/locations/us/discoveryConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a paused discovery config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.DLP.LocationsInspectTemplate(
            "EmailInspect",
            {
              location: "us",
              displayName: "emails",
              inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            },
          );
          return yield* GCP.DLP.DiscoveryConfig("Profiles", {
            location: "us",
            displayName: "paused storage",
            status: "PAUSED",
            inspectTemplates: [template.name],
            targets: [pausedTarget()],
          });
        }),
      );

      expect(created.configId).toEqual(expect.any(String));
      expect(created.location).toEqual("us");
      expect(created.name).toContain("/discoveryConfigs/");
      expect(created.displayName).toEqual("paused storage");
      expect(created.status).toEqual("PAUSED");

      const fetched = yield* dlp.getProjectsLocationsDiscoveryConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.DLP.LocationsInspectTemplate(
            "EmailInspect",
            {
              location: "us",
              displayName: "emails",
              inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            },
          );
          return yield* GCP.DLP.DiscoveryConfig("Profiles", {
            configId: created.configId,
            location: "us",
            displayName: "paused storage v2",
            status: "PAUSED",
            inspectTemplates: [template.name],
            targets: [pausedTarget()],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("paused storage v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
