import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsLakesZones({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a lake zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const zone = yield* GCP.Dataplex.LakesZone("Landing", {
            lake: lake.name,
            type: "RAW",
            locationType: "SINGLE_REGION",
            displayName: "landing a",
            description: "raw landing",
            labels: { env: "test" },
            discoverySpec: { enabled: false },
          });
          return { lake, zone };
        }),
      );

      expect(created.zone.name).toContain("/zones/");
      expect(created.zone.zoneId).toEqual(expect.any(String));
      expect(created.zone.lake).toEqual(created.lake.name);
      expect(created.zone.type).toEqual("RAW");
      expect(created.zone.locationType).toEqual("SINGLE_REGION");
      expect(created.zone.displayName).toEqual("landing a");
      expect(created.zone.labels).toMatchObject({ env: "test" });
      expect(created.zone.discoveryEnabled).toEqual(false);

      const fetched = yield* dataplex.getProjectsLocationsLakesZones({
        name: created.zone.name,
      });
      expect(fetched.name).toEqual(created.zone.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.type).toEqual("RAW");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const lake = yield* GCP.Dataplex.Lake("Warehouse", {
            lakeId: created.lake.lakeId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const zone = yield* GCP.Dataplex.LakesZone("Landing", {
            lake: lake.name,
            zoneId: created.zone.zoneId,
            type: "RAW",
            locationType: "SINGLE_REGION",
            displayName: "landing b",
            description: "raw landing b",
            labels: { env: "prod", team: "data" },
            discoverySpec: { enabled: false },
          });
          return { lake, zone };
        }),
      );

      expect(updated.zone.name).toEqual(created.zone.name);
      expect(updated.zone.displayName).toEqual("landing b");
      expect(updated.zone.description).toEqual("raw landing b");
      expect(updated.zone.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.zone.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
