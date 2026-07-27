import * as AWS from "@/AWS";
import { UserPool } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class UserPoolStillExists extends Data.TaggedError("UserPoolStillExists")<{
  readonly userPoolId: string;
}> {}

const assertPoolDeleted = (userPoolId: string) =>
  cip.describeUserPool({ UserPoolId: userPoolId }).pipe(
    Effect.flatMap(() => Effect.fail(new UserPoolStillExists({ userPoolId }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "UserPoolStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update policy and tags, no-op, delete user pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("LifecyclePool", {
            passwordPolicy: { minimumLength: 10 },
            adminCreateUserOnly: true,
            tags: { Environment: "test" },
          });
        }),
      );

      expect(pool.userPoolId).toMatch(/^[a-z0-9-]+_[A-Za-z0-9]+$/);
      expect(pool.userPoolArn).toContain(":userpool/");
      expect(pool.userPoolName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* cip.describeUserPool({
        UserPoolId: pool.userPoolId,
      });
      expect(created.UserPool?.Name).toBe(pool.userPoolName);
      expect(created.UserPool?.Policies?.PasswordPolicy?.MinimumLength).toBe(
        10,
      );
      expect(
        created.UserPool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly,
      ).toBe(true);
      expect(created.UserPool?.MfaConfiguration).toBe("OFF");
      expect(created.UserPool?.DeletionProtection).toBe("INACTIVE");

      const tags = yield* cip.listTagsForResource({
        ResourceArn: pool.userPoolArn,
      });
      expect(tags.Tags?.Environment).toBe("test");
      expect(tags.Tags?.["alchemy::id"]).toBe("LifecyclePool");

      // update the password policy and tag set in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("LifecyclePool", {
            passwordPolicy: { minimumLength: 14, requireSymbols: false },
            adminCreateUserOnly: true,
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.userPoolId).toBe(pool.userPoolId);

      const afterUpdate = yield* cip.describeUserPool({
        UserPoolId: pool.userPoolId,
      });
      expect(
        afterUpdate.UserPool?.Policies?.PasswordPolicy?.MinimumLength,
      ).toBe(14);
      expect(
        afterUpdate.UserPool?.Policies?.PasswordPolicy?.RequireSymbols,
      ).toBe(false);
      const updatedTags = yield* cip.listTagsForResource({
        ResourceArn: pool.userPoolArn,
      });
      expect(updatedTags.Tags?.Extra).toBe("1");

      // removing a tag converges
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("LifecyclePool", {
            passwordPolicy: { minimumLength: 14, requireSymbols: false },
            adminCreateUserOnly: true,
            tags: { Environment: "test" },
          });
        }),
      );
      const afterRemoval = yield* cip.listTagsForResource({
        ResourceArn: pool.userPoolArn,
      });
      expect(afterRemoval.Tags?.Extra).toBeUndefined();
      expect(afterRemoval.Tags?.Environment).toBe("test");

      yield* stack.destroy();
      yield* assertPoolDeleted(pool.userPoolId);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom schema attributes are added in place; sign-in change replaces",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("SchemaPool", {
            schema: [{ name: "tenantId", mutable: true }],
          });
        }),
      );

      const created = yield* cip.describeUserPool({
        UserPoolId: pool.userPoolId,
      });
      const names = (created.UserPool?.SchemaAttributes ?? []).map(
        (a) => a.Name,
      );
      expect(names).toContain("custom:tenantId");

      // adding an attribute updates in place
      const withMore = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("SchemaPool", {
            schema: [
              { name: "tenantId", mutable: true },
              { name: "plan", mutable: true },
            ],
          });
        }),
      );
      expect(withMore.userPoolId).toBe(pool.userPoolId);
      const afterAdd = yield* cip.describeUserPool({
        UserPoolId: pool.userPoolId,
      });
      const afterAddNames = (afterAdd.UserPool?.SchemaAttributes ?? []).map(
        (a) => a.Name,
      );
      expect(afterAddNames).toContain("custom:plan");

      // switching to email sign-in is immutable ⇒ replacement
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("SchemaPool", {
            schema: [
              { name: "tenantId", mutable: true },
              { name: "plan", mutable: true },
            ],
            usernameAttributes: ["email"],
          });
        }),
      );
      expect(replaced.userPoolId).not.toBe(pool.userPoolId);
      const replacedPool = yield* cip.describeUserPool({
        UserPoolId: replaced.userPoolId,
      });
      expect(replacedPool.UserPool?.UsernameAttributes).toEqual(["email"]);
      yield* assertPoolDeleted(pool.userPoolId);

      yield* stack.destroy();
      yield* assertPoolDeleted(replaced.userPoolId);
    }),
  { timeout: 120_000 },
);
