import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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

// Needs a provisioned API Hub instance in us-central1 (one per project,
// behind a host project registration); without one writes fail with
// BadRequest ("Invalid resource state … API Hub instance …"). Set
// GCP_TEST_APIHUB_INSTANCE=1 when the hub exists.
const runLifecycle = !!process.env.GCP_TEST_APIHUB_INSTANCE;
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsPluginsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsPluginsInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsPluginsInstances({
          name: `projects/${project}/locations/${location}/plugins/alchemy-missing-plugin/instances/alchemy-missing-instance`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub plugin instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.ApiHub.Plugin("OnRamp", {
            location,
            displayName: "on-ramp",
            description: "plugin for instance test",
          });
          const instance = yield* GCP.ApiHub.PluginsInstance("Collector", {
            plugin: plugin.name,
            displayName: "orders collector",
            actions: [{ actionId: "sync-metadata" }],
          });
          return { plugin, instance };
        }),
      );

      expect(created.instance.name).toContain("/instances/");
      expect(created.instance.plugin).toEqual(created.plugin.name);
      expect(created.instance.displayName).toEqual("orders collector");
      expect(created.instance.location).toEqual(location);

      const fetched = yield* apihub.getProjectsLocationsPluginsInstances({
        name: created.instance.name,
      });
      expect(fetched.name).toEqual(created.instance.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("orders collector");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.ApiHub.Plugin("OnRamp", {
            pluginId: created.plugin.pluginId,
            location,
            displayName: "on-ramp",
            description: "plugin for instance test",
          });
          const instance = yield* GCP.ApiHub.PluginsInstance("Collector", {
            plugin: plugin.name,
            pluginInstanceId: created.instance.pluginInstanceId,
            displayName: "orders collector (updated)",
            actions: [{ actionId: "sync-metadata" }],
          });
          return { plugin, instance };
        }),
      );

      expect(updated.instance.name).toEqual(created.instance.name);
      expect(updated.instance.displayName).toEqual(
        "orders collector (updated)",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.instance.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 120_000 },
);
