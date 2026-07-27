import * as AWS from "@/AWS";
import { ScheduleGroup } from "@/AWS/Scheduler";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class ScheduleGroupNotListed extends Data.TaggedError(
  "ScheduleGroupNotListed",
) {}

test.provider(
  "list enumerates the deployed schedule group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ScheduleGroup("ListScheduleGroup", {});
        }),
      );

      const provider = yield* Provider.findProvider(ScheduleGroup);

      // EventBridge Scheduler is eventually consistent: a freshly-created group
      // may not appear in listScheduleGroups immediately. Retry the list
      // assertion on a bounded schedule.
      yield* Effect.gen(function* () {
        const all = yield* provider.list();
        if (
          !all.some((g) => g.scheduleGroupArn === deployed.scheduleGroupArn)
        ) {
          return yield* Effect.fail(new ScheduleGroupNotListed());
        }
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ScheduleGroupNotListed",
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
