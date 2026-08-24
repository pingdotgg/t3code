import * as AWS from "@/AWS";
import { Schedule } from "@/AWS/DataBrew";
import * as Test from "@/Test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getSchedule = (name: string) =>
  databrew
    .describeSchedule({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const withSchedule = (cronExpression: string) =>
  Effect.gen(function* () {
    const schedule = yield* Schedule("Nightly", {
      cronExpression,
      tags: { Environment: "test" },
    });
    return { schedule };
  });

test.provider(
  "create, update, delete a schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(withSchedule("cron(0 3 * * ? *)"));
      expect(created.schedule.scheduleArn).toContain(
        `:schedule/${created.schedule.scheduleName}`,
      );

      // out-of-band verification
      const observed = yield* getSchedule(created.schedule.scheduleName);
      expect(observed?.CronExpression).toEqual("cron(0 3 * * ? *)");
      expect(observed?.Tags?.["alchemy::id"]).toBeDefined();
      expect(observed?.Tags?.Environment).toEqual("test");

      // update: new cron expression (same logical resource)
      yield* stack.deploy(withSchedule("cron(30 4 * * ? *)"));
      const updated = yield* getSchedule(created.schedule.scheduleName);
      expect(updated?.CronExpression).toEqual("cron(30 4 * * ? *)");

      yield* stack.destroy();
      expect(yield* getSchedule(created.schedule.scheduleName)).toBeUndefined();
    }),
  { timeout: 120_000 },
);
