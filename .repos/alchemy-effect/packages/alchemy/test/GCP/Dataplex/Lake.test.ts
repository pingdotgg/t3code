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
  dataplex.getProjectsLocationsLakes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a lake",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.Lake("Warehouse", {
            location: "us-central1",
            displayName: "lake a",
            description: "lake a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/lakes/");
      expect(created.lakeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("lake a");
      expect(created.description).toEqual("lake a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsLakes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.Lake("Warehouse", {
            lakeId: created.lakeId,
            location: "us-central1",
            displayName: "lake b",
            description: "lake b",
            labels: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("lake b");
      expect(updated.description).toEqual("lake b");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
