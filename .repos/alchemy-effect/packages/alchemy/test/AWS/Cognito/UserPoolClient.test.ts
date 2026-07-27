import * as AWS from "@/AWS";
import { UserPool, UserPoolClient } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update auth flows and validity, replace on generateSecret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("ClientTestPool", {});
          const client = yield* UserPoolClient("Client", {
            userPoolId: pool.userPoolId,
            explicitAuthFlows: [
              "ALLOW_USER_PASSWORD_AUTH",
              "ALLOW_REFRESH_TOKEN_AUTH",
            ],
          });
          return { pool, client };
        }),
      );

      expect(outputs.client.clientId).toBeTruthy();
      expect(outputs.client.clientSecret).toBeUndefined();
      expect(outputs.client.userPoolId).toBe(outputs.pool.userPoolId);

      // out-of-band verification via distilled
      const created = yield* cip.describeUserPoolClient({
        UserPoolId: outputs.pool.userPoolId,
        ClientId: outputs.client.clientId,
      });
      expect(
        [...(created.UserPoolClient?.ExplicitAuthFlows ?? [])].sort(),
      ).toEqual(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"]);

      // mutate token validity in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("ClientTestPool", {});
          const client = yield* UserPoolClient("Client", {
            userPoolId: pool.userPoolId,
            explicitAuthFlows: [
              "ALLOW_USER_PASSWORD_AUTH",
              "ALLOW_REFRESH_TOKEN_AUTH",
            ],
            accessTokenValidity: 30,
            idTokenValidity: 30,
            tokenValidityUnits: { accessToken: "minutes", idToken: "minutes" },
          });
          return { pool, client };
        }),
      );
      expect(updated.client.clientId).toBe(outputs.client.clientId);

      const afterUpdate = yield* cip.describeUserPoolClient({
        UserPoolId: outputs.pool.userPoolId,
        ClientId: outputs.client.clientId,
      });
      expect(afterUpdate.UserPoolClient?.AccessTokenValidity).toBe(30);
      expect(afterUpdate.UserPoolClient?.TokenValidityUnits?.AccessToken).toBe(
        "minutes",
      );

      // generateSecret is immutable ⇒ replacement with a fresh client id
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("ClientTestPool", {});
          const client = yield* UserPoolClient("Client", {
            userPoolId: pool.userPoolId,
            generateSecret: true,
            explicitAuthFlows: [
              "ALLOW_USER_PASSWORD_AUTH",
              "ALLOW_REFRESH_TOKEN_AUTH",
            ],
          });
          return { pool, client };
        }),
      );
      expect(replaced.client.clientId).not.toBe(outputs.client.clientId);
      expect(replaced.client.clientSecret).toBeTruthy();

      yield* stack.destroy();
      const gone = yield* cip
        .describeUserPoolClient({
          UserPoolId: outputs.pool.userPoolId,
          ClientId: replaced.client.clientId,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);
