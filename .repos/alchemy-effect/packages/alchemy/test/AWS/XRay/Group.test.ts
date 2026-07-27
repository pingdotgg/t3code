import * as AWS from "@/AWS";
import { Group } from "@/AWS/XRay";
import * as Test from "@/Test/Alchemy";
import * as xray from "@distilled.cloud/aws/xray";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findGroup = (groupName: string) =>
  xray.getGroup({ GroupName: groupName }).pipe(
    Effect.map((r) => r.Group),
    Effect.catchTag("GroupNotFound", () => Effect.succeed(undefined)),
  );

class GroupStillExists extends Data.TaggedError("GroupStillExists")<{
  readonly groupName: string;
}> {}

const assertGroupDeleted = (groupName: string) =>
  findGroup(groupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new GroupStillExists({ groupName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GroupStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update filter + insights, delete group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("TestGroup", {
            filterExpression: 'service("alchemy-xray-test")',
            tags: { Environment: "test" },
          });
        }),
      );

      expect(group.groupName).toBeDefined();
      expect(group.groupArn).toContain(":group/");

      // out-of-band verification via distilled
      const created = yield* findGroup(group.groupName);
      expect(created?.FilterExpression).toBe('service("alchemy-xray-test")');
      expect(created?.InsightsConfiguration?.InsightsEnabled).toBe(false);
      const tags = yield* xray
        .listTagsForResource({ ResourceARN: group.groupArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestGroup");

      // update the filter expression and enable insights
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("TestGroup", {
            filterExpression:
              'service("alchemy-xray-test") AND responsetime > 2',
            insightsEnabled: true,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.groupName).toBe(group.groupName);
      expect(updated.groupArn).toBe(group.groupArn);

      const afterUpdate = yield* findGroup(group.groupName);
      expect(afterUpdate?.FilterExpression).toBe(
        'service("alchemy-xray-test") AND responsetime > 2',
      );
      expect(afterUpdate?.InsightsConfiguration?.InsightsEnabled).toBe(true);

      // disabling insights converges back
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("TestGroup", {
            filterExpression:
              'service("alchemy-xray-test") AND responsetime > 2',
            tags: { Environment: "test" },
          });
        }),
      );
      const afterDisable = yield* findGroup(group.groupName);
      expect(afterDisable?.InsightsConfiguration?.InsightsEnabled).toBe(false);

      yield* stack.destroy();
      yield* assertGroupDeleted(group.groupName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom group name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("NamedGroup", {
            groupName: "alchemy-test-group-a",
            filterExpression: 'service("alchemy-a")',
          });
        }),
      );
      expect(first.groupName).toBe("alchemy-test-group-a");

      // renaming triggers a replacement: new physical group, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Group("NamedGroup", {
            groupName: "alchemy-test-group-b",
            filterExpression: 'service("alchemy-b")',
          });
        }),
      );
      expect(second.groupName).toBe("alchemy-test-group-b");

      const observed = yield* findGroup("alchemy-test-group-b");
      expect(observed?.FilterExpression).toBe('service("alchemy-b")');
      yield* assertGroupDeleted("alchemy-test-group-a");

      yield* stack.destroy();
      yield* assertGroupDeleted("alchemy-test-group-b");
    }),
  { timeout: 120_000 },
);
