import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const ARCHIVE_NAME = "alchemy-test-eb-archive-res";

test.provider(
  "archive lifecycle: create with Duration retention, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — retention is a Duration.Input converted to RetentionDays.
      const { archive } = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* AWS.EventBridge.EventBus("ArchiveBus", {
            name: "alchemy-test-eb-archive-bus",
          });
          const archive = yield* AWS.EventBridge.Archive("TestArchive", {
            name: ARCHIVE_NAME,
            eventSourceArn: bus.eventBusArn,
            eventPattern: { source: ["alchemy.test"] },
            retention: "1 day",
          });
          return { archive };
        }),
      );

      expect(archive.archiveName).toBe(ARCHIVE_NAME);
      expect(archive.archiveArn).toContain(`:archive/${ARCHIVE_NAME}`);

      // Out-of-band verify via distilled.
      const created = yield* eventbridge.describeArchive({
        ArchiveName: ARCHIVE_NAME,
      });
      expect(created.RetentionDays).toBe(1);
      expect(created.EventPattern).toBeTruthy();

      // Update — retention and description sync in place (no replace).
      const { archive: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* AWS.EventBridge.EventBus("ArchiveBus", {
            name: "alchemy-test-eb-archive-bus",
          });
          const archive = yield* AWS.EventBridge.Archive("TestArchive", {
            name: ARCHIVE_NAME,
            eventSourceArn: bus.eventBusArn,
            eventPattern: { source: ["alchemy.test"] },
            retention: "2 days",
            description: "updated archive",
          });
          return { archive };
        }),
      );
      expect(updated.archiveArn).toBe(archive.archiveArn);

      const afterUpdate = yield* eventbridge.describeArchive({
        ArchiveName: ARCHIVE_NAME,
      });
      expect(afterUpdate.RetentionDays).toBe(2);
      expect(afterUpdate.Description).toBe("updated archive");

      yield* stack.destroy();

      // Typed wait-until-gone.
      const gone = yield* eventbridge
        .describeArchive({ ArchiveName: ARCHIVE_NAME })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isGone): boolean => isGone,
            times: 10,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);
