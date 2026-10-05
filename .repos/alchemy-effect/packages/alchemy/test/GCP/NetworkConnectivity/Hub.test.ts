import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
  networkconnectivity.getProjectsLocationsGlobalHubs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.Hub("Mesh", {
            description: "ncc hub a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/hubs/");
      expect(created.name).toContain("/locations/global/");
      expect(created.hubId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("ncc hub a");
      expect(created.exportPsc).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.uniqueId).toEqual(expect.any(String));
      expect(created.createTime).toEqual(expect.any(String));
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* networkconnectivity.getProjectsLocationsGlobalHubs(
        {
          name: created.name,
        },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("ncc hub a");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.Hub("Mesh", {
            hubId: created.hubId,
            description: "ncc hub b",
            exportPsc: true,
            labels: { env: "prod", role: "ncc" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uniqueId).toEqual(created.uniqueId);
      expect(updated.description).toEqual("ncc hub b");
      expect(updated.exportPsc).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ncc" });

      const refetched =
        yield* networkconnectivity.getProjectsLocationsGlobalHubs({
          name: created.name,
        });
      expect(refetched.description).toEqual("ncc hub b");
      expect(refetched.exportPsc).toEqual(true);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ncc");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 120_000,
  },
);
