import * as AWS from "@alchemy.run/aws";
import { Group, UserPool } from "@alchemy.run/aws/Cognito";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, rename (replace), delete group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("GroupTestPool", {});
          const group = yield* Group("Team", {
            userPoolId: pool.userPoolId,
            description: "first description",
            precedence: 5,
          });
          return { pool, group };
        }),
      );

      expect(outputs.group.groupName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* cip.getGroup({
        UserPoolId: outputs.pool.userPoolId,
        GroupName: outputs.group.groupName,
      });
      expect(created.Group?.Description).toBe("first description");
      expect(created.Group?.Precedence).toBe(5);

      // description/precedence mutate in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("GroupTestPool", {});
          const group = yield* Group("Team", {
            userPoolId: pool.userPoolId,
            description: "second description",
            precedence: 7,
          });
          return { pool, group };
        }),
      );
      expect(updated.group.groupName).toBe(outputs.group.groupName);
      const afterUpdate = yield* cip.getGroup({
        UserPoolId: outputs.pool.userPoolId,
        GroupName: outputs.group.groupName,
      });
      expect(afterUpdate.Group?.Description).toBe("second description");
      expect(afterUpdate.Group?.Precedence).toBe(7);

      // renaming replaces the group
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("GroupTestPool", {});
          const group = yield* Group("Team", {
            userPoolId: pool.userPoolId,
            groupName: "explicit-team-name",
            description: "second description",
            precedence: 7,
          });
          return { pool, group };
        }),
      );
      expect(renamed.group.groupName).toBe("explicit-team-name");
      const oldGone = yield* cip
        .getGroup({
          UserPoolId: outputs.pool.userPoolId,
          GroupName: outputs.group.groupName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        );
      expect(oldGone).toBe(true);

      yield* stack.destroy();
      const gone = yield* cip
        .getGroup({
          UserPoolId: outputs.pool.userPoolId,
          GroupName: "explicit-team-name",
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:cognito", "live"], timeout: 120_000 },
);
