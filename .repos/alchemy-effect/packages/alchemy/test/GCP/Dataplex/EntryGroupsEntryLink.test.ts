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

const RELATED_ENTRY_LINK_TYPE =
  "projects/dataplex-types/locations/global/entryLinkTypes/related";

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsEntryGroupsEntryLinks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an entry link",
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
          const left = yield* GCP.Dataplex.EntryGroupsEntry("Left", {
            entryGroup: group.name,
            entryType: type.name,
            labels: { env: "test" },
          });
          const right = yield* GCP.Dataplex.EntryGroupsEntry("Right", {
            entryGroup: group.name,
            entryType: type.name,
            labels: { env: "test" },
          });
          const link = yield* GCP.Dataplex.EntryGroupsEntryLink("Related", {
            entryGroup: group.name,
            entryLinkType: RELATED_ENTRY_LINK_TYPE,
            entryReferences: [
              { name: left.name, type: "UNSPECIFIED" },
              { name: right.name, type: "UNSPECIFIED" },
            ],
          });
          return { type, group, left, right, link };
        }),
      );

      expect(created.link.name).toContain("/entryLinks/");
      expect(created.link.entryGroup).toEqual(created.group.name);
      expect(created.link.entryLinkType).toContain("/entryLinkTypes/related");
      expect(created.link.entryReferences).toHaveLength(2);

      const fetched = yield* dataplex.getProjectsLocationsEntryGroupsEntryLinks(
        {
          name: created.link.name,
        },
      );
      expect(fetched.name).toEqual(created.link.name);
      expect(fetched.entryLinkType).toContain("/entryLinkTypes/related");
      expect(fetched.entryReferences ?? []).toHaveLength(2);

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
          const left = yield* GCP.Dataplex.EntryGroupsEntry("Left", {
            entryGroup: group.name,
            entryId: created.left.entryId,
            entryType: type.name,
            labels: { env: "test" },
          });
          const right = yield* GCP.Dataplex.EntryGroupsEntry("Right", {
            entryGroup: group.name,
            entryId: created.right.entryId,
            entryType: type.name,
            labels: { env: "test" },
          });
          const link = yield* GCP.Dataplex.EntryGroupsEntryLink("Related", {
            entryGroup: group.name,
            entryLinkId: created.link.entryLinkId,
            entryLinkType: RELATED_ENTRY_LINK_TYPE,
            entryReferences: [
              { name: left.name, type: "UNSPECIFIED" },
              { name: right.name, type: "UNSPECIFIED" },
            ],
          });
          return { type, group, left, right, link };
        }),
      );

      expect(updated.link.name).toEqual(created.link.name);
      expect(updated.link.entryLinkType).toContain("/entryLinkTypes/related");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.link.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
