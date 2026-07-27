import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Stream as KinesisStream } from "@/AWS/Kinesis/Stream.ts";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import { SubscriptionFilter } from "@/AWS/Logs/SubscriptionFilter.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describeFilter = Effect.fn(function* (
  logGroupName: string,
  filterName: string,
) {
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
  return (described.subscriptionFilters ?? []).find(
    (filter) => filter.filterName === filterName,
  );
});

class SubscriptionFilterStillExists extends Data.TaggedError(
  "SubscriptionFilterStillExists",
)<{ readonly filterName: string }> {}

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
      const observedCreated = yield* describeFilter(
        created.logGroupName,
        created.filterName,
      );
      expect(observedCreated?.destinationArn).toBe(created.destinationArn);
      expect(observedCreated?.filterPattern ?? "").toBe("");
      expect(observedCreated?.distribution).toBe("ByLogStream");

      // update the pattern in place (same filter name — upsert semantics)
      const updated = yield* stack.deploy(
        infra({ filterPattern: "?ERROR ?Error" }),
      );
      expect(updated.filterName).toBe(created.filterName);

      const observedUpdated = yield* describeFilter(
        updated.logGroupName,
        updated.filterName,
      );
      expect(observedUpdated?.filterPattern).toBe("?ERROR ?Error");

      // explicit filterName triggers a replacement
      const replaced = yield* stack.deploy(
        infra({
          filterName: "alchemy-test-subscription-renamed",
          filterPattern: "?ERROR ?Error",
        }),
      );
      expect(replaced.filterName).toBe("alchemy-test-subscription-renamed");
      expect(
        yield* describeFilter(replaced.logGroupName, replaced.filterName),
      ).toBeDefined();
      yield* assertFilterDeleted(created.logGroupName, created.filterName);

      yield* stack.destroy();
      yield* assertFilterDeleted(replaced.logGroupName, replaced.filterName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 240_000 },
);
