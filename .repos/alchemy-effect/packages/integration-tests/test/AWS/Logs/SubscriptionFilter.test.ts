import * as AWS from "@alchemy.run/aws";
import { Role } from "@alchemy.run/aws/IAM/Role";
import { Stream as KinesisStream } from "@alchemy.run/aws/Kinesis/Stream";
import { LogGroup } from "@alchemy.run/aws/Logs/LogGroup";
import { SubscriptionFilter } from "@alchemy.run/aws/Logs/SubscriptionFilter";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, driftOf, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

const describeFilter = Effect.fn(function* (logGroupName: string, filterName: string) {
  const described = yield* logs
    .describeSubscriptionFilters({
      logGroupName,
      filterNamePrefix: filterName,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed({ subscriptionFilters: [] }),
      ),
    );
  return (described.subscriptionFilters ?? []).find((filter) => filter.filterName === filterName);
});

class SubscriptionFilterStillExists extends Data.TaggedError("SubscriptionFilterStillExists")<{
  readonly filterName: string;
}> {}

const assertFilterDeleted = (logGroupName: string, filterName: string) =>
  describeFilter(logGroupName, filterName).pipe(
    Effect.flatMap((filter) =>
      filter === undefined
        ? Effect.void
        : Effect.fail(new SubscriptionFilterStillExists({ filterName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "SubscriptionFilterStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Kinesis-backed subscription filter: exercises the roleArn + distribution
// path (the Lambda destination path is covered end-to-end by
// LogGroupEventSource.test.ts).
const infra = (filterProps: { filterName?: string; filterPattern: string }) =>
  Effect.gen(function* () {
    const logGroup = yield* LogGroup("SubFilterLogGroup", {
      retention: "1 day",
    });
    const stream = yield* KinesisStream("SubFilterStream", {});
    const role = yield* Role("SubFilterDeliveryRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "logs.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        "kinesis-put": {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["kinesis:PutRecord"],
              Resource: [stream.streamArn],
            },
          ],
        },
      },
    });
    return yield* SubscriptionFilter("KinesisFanout", {
      logGroupName: logGroup.logGroupName,
      filterName: filterProps.filterName,
      filterPattern: filterProps.filterPattern,
      destinationArn: stream.streamArn,
      roleArn: role.roleArn,
      distribution: "ByLogStream",
    });
  });

test.provider(
  "create, update pattern, replace on rename, delete subscription filter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(infra({ filterPattern: "" }));

      expect(created.filterName).toBeDefined();
      expect(created.destinationArn).toContain(":stream/");

      // out-of-band verification via distilled
      const observedCreated = yield* describeFilter(created.logGroupName, created.filterName);
      expect(observedCreated?.destinationArn).toBe(created.destinationArn);
      expect(observedCreated?.filterPattern ?? "").toBe("");
      expect(observedCreated?.distribution).toBe("ByLogStream");

      // update the pattern in place (same filter name — upsert semantics)
      const updated = yield* stack.deploy(infra({ filterPattern: "?ERROR ?Error" }));
      expect(updated.filterName).toBe(created.filterName);

      const observedUpdated = yield* describeFilter(updated.logGroupName, updated.filterName);
      expect(observedUpdated?.filterPattern).toBe("?ERROR ?Error");

      // explicit filterName triggers a replacement
      const replaced = yield* stack.deploy(
        infra({
          filterName: "alchemy-test-subscription-renamed",
          filterPattern: "?ERROR ?Error",
        }),
      );
      expect(replaced.filterName).toBe("alchemy-test-subscription-renamed");
      expect(yield* describeFilter(replaced.logGroupName, replaced.filterName)).toBeDefined();
      yield* assertFilterDeleted(created.logGroupName, created.filterName);

      yield* stack.destroy();
      yield* assertFilterDeleted(replaced.logGroupName, replaced.filterName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:kinesis", "provider:aws:logs", "live"],
    timeout: 240_000,
  },
);

// #2688: `read` and `reconcile` must report the same distribution and
// applyOnTransformedLogs, and `read` must see out-of-band changes.
test.provider(
  "drift detects and repairs an out-of-band subscription filter change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const filter = yield* stack.deploy(infra({ filterPattern: "?ERROR" }));
      const actions = yield* driftActions(stack);
      expect(Object.values(actions).every((action) => action === "unchanged")).toBe(true);

      const observed = yield* describeFilter(filter.logGroupName, filter.filterName);
      yield* logs.putSubscriptionFilter({
        logGroupName: filter.logGroupName,
        filterName: filter.filterName,
        filterPattern: observed?.filterPattern ?? "",
        destinationArn: filter.destinationArn,
        roleArn: filter.roleArn,
        distribution: "Random",
      });

      const drifted = yield* waitForDrift(stack, "KinesisFanout", "drifted");
      expect(drifted?.attr?.distribution).toBe("Random");

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.KinesisFanout?.action).toBe("repaired");
      expect((yield* driftOf(stack, "KinesisFanout"))?.action).toBe("unchanged");
      const restored = yield* describeFilter(filter.logGroupName, filter.filterName);
      expect(restored?.distribution).toBe("ByLogStream");

      yield* stack.destroy();
      yield* assertFilterDeleted(filter.logGroupName, filter.filterName);
    }),
  { tags: ["provider:aws", "provider:aws:logs", "provider:aws:kinesis", "live"], timeout: 240_000 },
);
