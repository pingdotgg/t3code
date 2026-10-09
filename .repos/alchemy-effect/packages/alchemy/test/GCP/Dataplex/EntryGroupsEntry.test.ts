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
  dataplex.getProjectsLocationsEntryGroupsEntries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const type = yield* GCP.Dataplex.EntryType("Kind", {
            location: "us-central1",
            displayName: "kind",
          });
          const group = yield* GCP.Dataplex.EntryGroup("Catalog", {
            location: "us-central1",
            displayName: "catalog",
            labels: { env: "test" },
          });
          const entry = yield* GCP.Dataplex.EntryGroupsEntry("Orders", {
            entryGroup: group.name,
            entryType: type.name,
            fullyQualifiedName: "custom:orders",
            entrySource: {
              system: "custom",
              platform: "alchemy",
              displayName: "orders a",
            },
            labels: { env: "test" },
          });
          return { type, group, entry };
        }),
      );

      expect(created.entry.name).toContain("/entries/");
      expect(created.entry.entryGroup).toEqual(created.group.name);
      expect(created.entry.entryType).toContain(created.type.entryTypeId);
      expect(created.entry.fullyQualifiedName).toEqual("custom:orders");
      expect(created.entry.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsEntryGroupsEntries({
        name: created.entry.name,
        view: "ALL",
      });
      expect(fetched.name).toEqual(created.entry.name);
      expect(fetched.entryType).toContain(created.type.entryTypeId);
      expect(fetched.entrySource?.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.entrySource?.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const type = yield* GCP.Dataplex.EntryType("Kind", {
            entryTypeId: created.type.entryTypeId,
            location: "us-central1",
            displayName: "kind",
          });
          const group = yield* GCP.Dataplex.EntryGroup("Catalog", {
            entryGroupId: created.group.entryGroupId,
            location: "us-central1",
            displayName: "catalog",
            labels: { env: "test" },
          });
          const entry = yield* GCP.Dataplex.EntryGroupsEntry("Orders", {
            entryGroup: group.name,
            entryId: created.entry.entryId,
            entryType: type.name,
            fullyQualifiedName: "custom:orders.v2",
            entrySource: {
              system: "custom",
              platform: "alchemy",
              displayName: "orders b",
            },
            labels: { env: "prod", team: "data" },
          });
          return { type, group, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.fullyQualifiedName).toEqual("custom:orders.v2");
      expect(updated.entry.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
