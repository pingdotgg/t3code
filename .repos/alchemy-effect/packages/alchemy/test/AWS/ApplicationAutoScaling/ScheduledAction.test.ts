import * as AWS from "@/AWS";
import { ScalableTarget, ScheduledAction } from "@/AWS/ApplicationAutoScaling";
import { Table } from "@/AWS/DynamoDB";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describeAction = (scheduledActionName: string) =>
  aas
    .describeScheduledActions({
      ServiceNamespace: "dynamodb",
      ScheduledActionNames: [scheduledActionName],
    })
    .pipe(
      Effect.map((res) =>
        res.ScheduledActions?.find(
          (a) => a.ScheduledActionName === scheduledActionName,
        ),
      ),
    );

const waitUntilActionGone = (scheduledActionName: string) =>
  describeAction(scheduledActionName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (action) => action === undefined,
      times: 10,
    }),
  );

// Scheduled-action lifecycle against a provisioned DynamoDB table. The
// schedule is a far-future one-time `at(...)` so the action never actually
// fires during the test.
test.provider(
  "scheduled action lifecycle (dynamodb)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: { schedule: string; minCapacity: number }) =>
        stack.deploy(
          Effect.gen(function* () {
            const table = yield* Table("AasScheduleTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              billingMode: "PROVISIONED",
              provisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1,
              },
            });
            const target = yield* ScalableTarget("AasScheduleTarget", {
              serviceNamespace: "dynamodb",
              resourceId: Output.interpolate`table/${table.tableName}`,
              scalableDimension: "dynamodb:table:ReadCapacityUnits",
              minCapacity: 1,
              maxCapacity: 10,
            });
            const action = yield* ScheduledAction("AasScheduledAction", {
              serviceNamespace: target.serviceNamespace,
              resourceId: target.resourceId,
              scalableDimension: target.scalableDimension,
              schedule: props.schedule,
              timezone: "UTC",
              scalableTargetAction: { MinCapacity: props.minCapacity },
            });
            return {
              resourceId: target.resourceId.as<string>(),
              scheduledActionName: action.scheduledActionName.as<string>(),
              scheduledActionArn: action.scheduledActionArn.as<string>(),
              schedule: action.schedule.as<string>(),
            };
          }),
        );

      const created = yield* deploy({
        schedule: "at(2030-01-01T00:00:00)",
        minCapacity: 2,
      });
      expect(created.scheduledActionArn).toContain("scheduledAction");
      expect(created.schedule).toBe("at(2030-01-01T00:00:00)");

      // Out-of-band: the action is attached to the target with the requested
      // capacity adjustment.
      const observed = yield* describeAction(created.scheduledActionName);
      expect(observed?.Schedule).toBe("at(2030-01-01T00:00:00)");
      expect(observed?.ScalableTargetAction?.MinCapacity).toBe(2);
      expect(observed?.ResourceId).toBe(created.resourceId);

      // Update in place — `putScheduledAction` upserts by (name, target).
      const updated = yield* deploy({
        schedule: "at(2030-06-01T00:00:00)",
        minCapacity: 3,
      });
      expect(updated.scheduledActionName).toEqual(created.scheduledActionName);
      expect(updated.scheduledActionArn).toEqual(created.scheduledActionArn);
      const observedAfterUpdate = yield* describeAction(
        created.scheduledActionName,
      );
      expect(observedAfterUpdate?.Schedule).toBe("at(2030-06-01T00:00:00)");
      expect(observedAfterUpdate?.ScalableTargetAction?.MinCapacity).toBe(3);

      yield* stack.destroy();
      const gone = yield* waitUntilActionGone(created.scheduledActionName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
