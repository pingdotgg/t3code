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
  dataplex.getProjectsLocationsEntryTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an entry type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.EntryType("Table", {
            location: "us-central1",
            displayName: "table a",
            description: "type a",
            typeAliases: ["TABLE"],
            platform: "GCS",
            system: "Cloud Storage",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/entryTypes/");
      expect(created.entryTypeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("table a");
      expect(created.description).toEqual("type a");
      expect(created.typeAliases).toContain("TABLE");
      expect(created.platform).toEqual("GCS");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsEntryTypes({
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
          return yield* GCP.Dataplex.EntryType("Table", {
            entryTypeId: created.entryTypeId,
            location: "us-central1",
            displayName: "table b",
            description: "type b",
            typeAliases: ["TABLE", "DATASET"],
            platform: "GCS",
            system: "Cloud Storage",
            labels: { env: "prod", team: "data" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("table b");
      expect(updated.description).toEqual("type b");
      expect(updated.typeAliases).toEqual(
        expect.arrayContaining(["TABLE", "DATASET"]),
      );
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
