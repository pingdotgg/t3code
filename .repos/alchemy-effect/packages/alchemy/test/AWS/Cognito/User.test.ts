import * as AWS from "@/AWS";
import { User, UserPool } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const PASSWORD = "Alchemy-User-Passw0rd1";

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const attributeValue = (
  attributes: cip.AttributeType[] | undefined,
  name: string,
) => plain(attributes?.find((attribute) => attribute.Name === name)?.Value);

test.provider(
  "create confirmed user, update attributes/enabled, rename (replace), delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("UserTestPool", {
            passwordPolicy: { minimumLength: 12, requireSymbols: false },
            accountRecovery: [{ name: "admin_only", priority: 1 }],
          });
          const user = yield* User("Admin", {
            userPoolId: pool.userPoolId,
            attributes: {
              email: "admin@example.com",
              email_verified: "true",
            },
            password: Redacted.make(PASSWORD),
          });
          return { pool, user };
        }),
      );

      expect(outputs.user.username).toBeDefined();
      expect(outputs.user.sub).toBeTruthy();
      // permanent password ⇒ account is CONFIRMED without any invite flow
      expect(outputs.user.userStatus).toBe("CONFIRMED");

      // out-of-band verification via distilled
      const created = yield* cip.adminGetUser({
        UserPoolId: outputs.pool.userPoolId,
        Username: outputs.user.username,
      });
      expect(created.Enabled).toBe(true);
      expect(created.UserStatus).toBe("CONFIRMED");
      expect(attributeValue(created.UserAttributes, "email")).toBe(
        "admin@example.com",
      );
      expect(attributeValue(created.UserAttributes, "email_verified")).toBe(
        "true",
      );

      // attributes and enabled mutate in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("UserTestPool", {
            passwordPolicy: { minimumLength: 12, requireSymbols: false },
            accountRecovery: [{ name: "admin_only", priority: 1 }],
          });
          const user = yield* User("Admin", {
            userPoolId: pool.userPoolId,
            attributes: {
              email: "admin2@example.com",
              email_verified: "true",
            },
            password: Redacted.make(PASSWORD),
            enabled: false,
          });
          return { pool, user };
        }),
      );
      expect(updated.user.username).toBe(outputs.user.username);
      expect(updated.user.sub).toBe(outputs.user.sub);
      const afterUpdate = yield* cip.adminGetUser({
        UserPoolId: outputs.pool.userPoolId,
        Username: outputs.user.username,
      });
      expect(afterUpdate.Enabled).toBe(false);
      expect(attributeValue(afterUpdate.UserAttributes, "email")).toBe(
        "admin2@example.com",
      );

      // an explicit username replaces the user
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("UserTestPool", {
            passwordPolicy: { minimumLength: 12, requireSymbols: false },
            accountRecovery: [{ name: "admin_only", priority: 1 }],
          });
          const user = yield* User("Admin", {
            userPoolId: pool.userPoolId,
            username: "explicit-admin",
            attributes: {
              email: "admin2@example.com",
              email_verified: "true",
            },
            password: Redacted.make(PASSWORD),
          });
          return { pool, user };
        }),
      );
      expect(renamed.user.username).toBe("explicit-admin");
      expect(renamed.user.sub).not.toBe(outputs.user.sub);
      const oldGone = yield* cip
        .adminGetUser({
          UserPoolId: outputs.pool.userPoolId,
          Username: outputs.user.username,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("UserNotFoundException", () => Effect.succeed(true)),
        );
      expect(oldGone).toBe(true);

      yield* stack.destroy();
      const gone = yield* cip
        .adminGetUser({
          UserPoolId: outputs.pool.userPoolId,
          Username: "explicit-admin",
        })
        .pipe(
          Effect.map(() => false),
          // the pool is destroyed with the stack, so the pool itself being
          // gone also proves the user is gone
          Effect.catchTag(
            ["UserNotFoundException", "ResourceNotFoundException"],
            () => Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);
