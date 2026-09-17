import * as AWS from "@/AWS";
import { UserPool } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";

const customEmailSenderPath = fileURLToPath(
  new URL("./custom-email-sender-handler.ts", import.meta.url),
);

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

// Regression: https://github.com/alchemy-run/alchemy/issues/1311 — email OTP
// through a CustomEmailSender needs `Policies.SignInPolicy`,
// `LambdaConfig.CustomEmailSender` and `LambdaConfig.KMSKeyID`, which the
// provider used to strip (it only ever sent the string trigger slots), and
// an unrelated update must never clear an already-configured sender.
test.provider(
  "email OTP sign-in policy with a custom email sender and KMS key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const sender = (passwordMinimumLength: number, withSender: boolean) =>
        Effect.gen(function* () {
          const key = yield* AWS.KMS.Key("CodeKey", {
            description: "alchemy cognito custom sender codes",
            deletionWindow: "7 days",
          });
          const fn = yield* AWS.Lambda.Function("EmailSender", {
            main: customEmailSenderPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          const pool = yield* UserPool("OtpPool", {
            tier: "ESSENTIALS",
            usernameAttributes: ["email"],
            passwordPolicy: { minimumLength: passwordMinimumLength },
            signInPolicy: {
              allowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"],
            },
            ...(withSender
              ? {
                  customEmailSender: { lambdaArn: fn.functionArn },
                  kmsKeyId: key.keyArn,
                }
              : {}),
          });
          return { pool, fn, key };
        });

      const created = yield* stack.deploy(sender(8, true));

      const describe = () =>
        cip
          .describeUserPool({ UserPoolId: created.pool.userPoolId })
          .pipe(Effect.map((r) => r.UserPool!));

      const initial = yield* describe();
      expect(initial.UserPoolTier).toBe("ESSENTIALS");
      expect(
        [
          ...(initial.Policies?.SignInPolicy?.AllowedFirstAuthFactors ?? []),
        ].sort(),
      ).toEqual(["EMAIL_OTP", "PASSWORD"]);
      expect(initial.LambdaConfig?.CustomEmailSender).toEqual({
        LambdaArn: created.fn.functionArn,
        LambdaVersion: "V1_0",
      });
      expect(initial.LambdaConfig?.KMSKeyID).toBe(created.key.keyArn);

      // An unrelated update (password policy) must keep the custom sender,
      // KMS key and sign-in policy intact — updateUserPool resets anything
      // omitted from its body.
      const updated = yield* stack.deploy(sender(12, true));
      expect(updated.pool.userPoolId).toBe(created.pool.userPoolId);
      const afterUnrelated = yield* describe();
      expect(afterUnrelated.Policies?.PasswordPolicy?.MinimumLength).toBe(12);
      expect(
        [
          ...(afterUnrelated.Policies?.SignInPolicy?.AllowedFirstAuthFactors ??
            []),
        ].sort(),
      ).toEqual(["EMAIL_OTP", "PASSWORD"]);
      expect(afterUnrelated.LambdaConfig?.CustomEmailSender).toEqual({
        LambdaArn: created.fn.functionArn,
        LambdaVersion: "V1_0",
      });
      expect(afterUnrelated.LambdaConfig?.KMSKeyID).toBe(created.key.keyArn);

      // Explicitly dropping the sender clears it (and the key) on the pool.
      const removed = yield* stack.deploy(sender(12, false));
      expect(removed.pool.userPoolId).toBe(created.pool.userPoolId);
      const afterRemoval = yield* describe();
      expect(afterRemoval.LambdaConfig?.CustomEmailSender).toBeUndefined();
      expect(afterRemoval.LambdaConfig?.KMSKeyID).toBeUndefined();
      expect(afterRemoval.Policies?.PasswordPolicy?.MinimumLength).toBe(12);

      yield* stack.destroy();
      yield* assertPoolDeleted(created.pool.userPoolId);
    }),
  { timeout: 180_000 },
);

// UpdateUserPool resets any field omitted from its body to the service
// default — an unrelated update must echo the observed EmailConfiguration
// back rather than clear it.
test.provider(
  "email configuration is set, survives unrelated updates, and converges",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("EmailPool", {
            autoVerifiedAttributes: ["email"],
            emailConfiguration: {
              replyToEmailAddress: "support@example.com",
            },
          });
        }),
      );

      const describe = () =>
        cip
          .describeUserPool({ UserPoolId: pool.userPoolId })
          .pipe(Effect.map((r) => r.UserPool!));

      const created = yield* describe();
      expect(created.EmailConfiguration?.EmailSendingAccount).toBe(
        "COGNITO_DEFAULT",
      );
      expect(created.EmailConfiguration?.ReplyToEmailAddress).toBe(
        "support@example.com",
      );

      // an unrelated update that OMITS emailConfiguration must preserve the
      // observed configuration (updateUserPool would otherwise reset it)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("EmailPool", {
            autoVerifiedAttributes: ["email"],
            passwordPolicy: { minimumLength: 12 },
          });
        }),
      );
      expect(updated.userPoolId).toBe(pool.userPoolId);
      const afterUnrelated = yield* describe();
      expect(afterUnrelated.Policies?.PasswordPolicy?.MinimumLength).toBe(12);
      expect(afterUnrelated.EmailConfiguration?.ReplyToEmailAddress).toBe(
        "support@example.com",
      );

      // changing the declared configuration converges
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UserPool("EmailPool", {
            autoVerifiedAttributes: ["email"],
            passwordPolicy: { minimumLength: 12 },
            emailConfiguration: {
              replyToEmailAddress: "help@example.com",
            },
          });
        }),
      );
      const afterChange = yield* describe();
      expect(afterChange.EmailConfiguration?.ReplyToEmailAddress).toBe(
        "help@example.com",
      );
      expect(afterChange.EmailConfiguration?.EmailSendingAccount).toBe(
        "COGNITO_DEFAULT",
      );

      yield* stack.destroy();
      yield* assertPoolDeleted(pool.userPoolId);
    }),
  { timeout: 120_000 },
);

test.provider(
  "customEmailSender without kmsKeyId and passwordless factors on LITE fail early",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return undefined;
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        return (reason?.error as { _tag?: string } | undefined)?._tag;
      };

      const missingKey = yield* stack
        .deploy(
          UserPool("InvalidPool", {
            customEmailSender: {
              lambdaArn:
                "arn:aws:lambda:us-east-1:123456789012:function:sender",
            },
          }),
        )
        .pipe(Effect.exit);
      expect(failureTag(missingKey)).toBe("InvalidUserPoolConfiguration");

      const liteOtp = yield* stack
        .deploy(
          UserPool("InvalidPool", {
            tier: "LITE",
            signInPolicy: {
              allowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"],
            },
          }),
        )
        .pipe(Effect.exit);
      expect(failureTag(liteOtp)).toBe("InvalidUserPoolConfiguration");

      const developerWithoutSource = yield* stack
        .deploy(
          UserPool("InvalidPool", {
            emailConfiguration: { emailSendingAccount: "DEVELOPER" },
          }),
        )
        .pipe(Effect.exit);
      expect(failureTag(developerWithoutSource)).toBe(
        "InvalidUserPoolConfiguration",
      );

      // nothing was created — the validation runs before any API call
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
