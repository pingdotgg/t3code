import * as AWS from "@/AWS";
import { Activity } from "@/AWS/StepFunctions";
import * as Test from "@/Test/Alchemy";
import * as sfn from "@distilled.cloud/aws/sfn";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class ActivityStillExists extends Data.TaggedError("ActivityStillExists")<{
  readonly activityArn: string;
}> {}

const assertActivityDeleted = (activityArn: string) =>
  sfn.describeActivity({ activityArn }).pipe(
    Effect.flatMap(() => Effect.fail(new ActivityStillExists({ activityArn }))),
    Effect.catchTag("ActivityDoesNotExist", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ActivityStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update tags, destroy activity",
  (stack) =>
    Effect.gen(function* () {
      const activity = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Activity("Worker", {
            tags: { Environment: "test" },
          });
        }),
      );

      expect(activity.activityArn).toContain(":activity:");
      expect(activity.activityName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* sfn.describeActivity({
        activityArn: activity.activityArn,
      });
      expect(created.name).toBe(activity.activityName);

      const tags = yield* sfn.listTagsForResource({
        resourceArn: activity.activityArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.tags ?? []).map((t) => [t.key, t.value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord["alchemy::id"]).toBe("Worker");

      // tag update converges in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Activity("Worker", {
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.activityArn).toBe(activity.activityArn);
      const afterUpdate = yield* sfn.listTagsForResource({
        resourceArn: activity.activityArn,
      });
      expect(
        Object.fromEntries(
          (afterUpdate.tags ?? []).map((t) => [t.key, t.value]),
        ).Extra,
      ).toBe("1");

      yield* stack.destroy();
      yield* assertActivityDeleted(activity.activityArn);
    }),
  { timeout: 120_000 },
);
