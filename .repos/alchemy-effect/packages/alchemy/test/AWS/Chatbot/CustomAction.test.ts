import * as AWS from "@/AWS";
import { CustomAction } from "@/AWS/Chatbot";
import * as Test from "@/Test/Alchemy";
import * as chatbot from "@distilled.cloud/aws/chatbot";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findAction = (arn: string) =>
  chatbot.getCustomAction({ CustomActionArn: arn }).pipe(
    Effect.map((r) => r.CustomAction),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class CustomActionStillExists extends Data.TaggedError(
  "CustomActionStillExists",
)<{ readonly arn: string }> {}

const assertActionDeleted = (arn: string) =>
  findAction(arn).pipe(
    Effect.flatMap((action) =>
      action === undefined
        ? Effect.void
        : Effect.fail(new CustomActionStillExists({ arn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "CustomActionStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getCustomAction on a nonexistent action fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const error = yield* Effect.flip(
        chatbot.getCustomAction({
          CustomActionArn: `arn:aws:chatbot::${accountId}:custom-action/alchemy-probe-nonexistent`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 30_000 },
);

test.provider(
  "create, update definition + alias + attachments + tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const action = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomAction("TestAction", {
            commandText: "aws lambda list-functions",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(action.actionName).toBeDefined();
      expect(action.customActionArn).toContain(":custom-action/");

      // out-of-band verification via distilled
      const created = yield* findAction(action.customActionArn);
      expect(created?.Definition.CommandText).toBe("aws lambda list-functions");
      expect(created?.AliasName).toBeUndefined();
      const tags = yield* chatbot
        .listTagsForResource({ ResourceARN: action.customActionArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.Tags ?? []).map((t) => [t.TagKey, t.TagValue]),
            ),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestAction");

      // update the command, add an alias + a notification attachment, and
      // change the user tags
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomAction("TestAction", {
            commandText:
              "aws cloudwatch describe-alarms --alarm-names $AlarmName",
            aliasName: "alchemy-test-describe-alarm",
            attachments: [
              {
                // NotificationType is required by the live API even though
                // the model marks it optional (patched in distilled).
                notificationType: "CloudWatch",
                buttonText: "Describe alarm",
                criteria: [
                  { operator: "HAS_VALUE", variableName: "AlarmName" },
                ],
              },
            ],
            tags: { Environment: "production" },
          });
        }),
      );
      expect(updated.actionName).toBe(action.actionName);
      expect(updated.customActionArn).toBe(action.customActionArn);

      const afterUpdate = yield* findAction(action.customActionArn);
      expect(afterUpdate?.Definition.CommandText).toBe(
        "aws cloudwatch describe-alarms --alarm-names $AlarmName",
      );
      expect(afterUpdate?.AliasName).toBe("alchemy-test-describe-alarm");
      expect(afterUpdate?.Attachments?.[0]?.ButtonText).toBe("Describe alarm");
      expect(afterUpdate?.Attachments?.[0]?.Criteria?.[0]?.VariableName).toBe(
        "AlarmName",
      );
      const updatedTags = yield* chatbot
        .listTagsForResource({ ResourceARN: action.customActionArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.Tags ?? []).map((t) => [t.TagKey, t.TagValue]),
            ),
          ),
        );
      expect(updatedTags.Environment).toBe("production");

      yield* stack.destroy();
      yield* assertActionDeleted(action.customActionArn);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom action name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomAction("NamedAction", {
            actionName: "alchemy-test-action-a",
            commandText: "aws s3 ls",
          });
        }),
      );
      expect(first.actionName).toBe("alchemy-test-action-a");
      expect(first.customActionArn).toContain(
        ":custom-action/alchemy-test-action-a",
      );

      // renaming triggers a replacement: new physical action, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomAction("NamedAction", {
            actionName: "alchemy-test-action-b",
            commandText: "aws s3 ls",
          });
        }),
      );
      expect(second.actionName).toBe("alchemy-test-action-b");

      const observed = yield* findAction(second.customActionArn);
      expect(observed?.Definition.CommandText).toBe("aws s3 ls");
      yield* assertActionDeleted(first.customActionArn);

      yield* stack.destroy();
      yield* assertActionDeleted(second.customActionArn);
    }),
  { timeout: 120_000 },
);
