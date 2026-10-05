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
  apihub.getProjectsLocationsPlugins({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runLifecycle)(
  "getProjectsLocationsPlugins on a missing plugin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsPlugins({
          name: `projects/${project}/locations/${location}/plugins/alchemy-missing-plugin`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsPlugins fails with ApiHubNotProvisioned without an API hub instance",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsPlugins({
          name: `projects/${project}/locations/${location}/plugins/alchemy-missing-plugin`,
        }),
      );
      expect(error._tag).toEqual("ApiHubNotProvisioned");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, disable, and delete an API Hub plugin",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Plugin("OnRamp", {
            location,
            displayName: "on-ramp",
            description: "custom collector",
          });
        }),
      );

      expect(created.name).toContain("/plugins/");
      expect(created.pluginId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("on-ramp");
      expect(created.description).toEqual("custom collector");
      expect(created.pluginCategory).toEqual("API_PRODUCER");

      const fetched = yield* apihub.getProjectsLocationsPlugins({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("custom collector");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Plugin("OnRamp", {
            pluginId: created.pluginId,
            location,
            displayName: "on-ramp",
            description: "custom collector",
            enabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(
        updated.state === "DISABLED" || updated.state === undefined,
      ).toEqual(true);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
