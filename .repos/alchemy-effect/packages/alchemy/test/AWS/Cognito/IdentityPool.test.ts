import * as AWS from "@/AWS";
import {
  IdentityPool,
  IdentityPoolRoleAttachment,
  UserPool,
  UserPoolClient,
} from "@/AWS/Cognito";
import { Role } from "@/AWS/IAM";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as ci from "@distilled.cloud/aws/cognito-identity";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class IdentityPoolStillExists extends Data.TaggedError(
  "IdentityPoolStillExists",
)<{ readonly identityPoolId: string }> {}

const assertIdentityPoolDeleted = (identityPoolId: string) =>
  ci.describeIdentityPool({ IdentityPoolId: identityPoolId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new IdentityPoolStillExists({ identityPoolId })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IdentityPoolStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "identity pool lifecycle with user pool federation and tags",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const identities = yield* IdentityPool("Identities", {
            allowUnauthenticatedIdentities: false,
            tags: { Environment: "test" },
          });
          return { identities };
        }),
      );

      expect(outputs.identities.identityPoolId).toContain(":");
      expect(outputs.identities.identityPoolArn).toContain(":identitypool/");

      // out-of-band verification via distilled
      const created = yield* ci.describeIdentityPool({
        IdentityPoolId: outputs.identities.identityPoolId,
      });
      expect(created.IdentityPoolName).toBe(
        outputs.identities.identityPoolName,
      );
      expect(created.AllowUnauthenticatedIdentities).toBe(false);
      const tags = yield* ci.listTagsForResource({
        ResourceArn: outputs.identities.identityPoolArn,
      });
      expect(tags.Tags?.Environment).toBe("test");
      expect(tags.Tags?.["alchemy::id"]).toBe("Identities");

      // update in place: federate a user pool + allow guests
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("FederatedPool", {});
          const client = yield* UserPoolClient("FederatedClient", {
            userPoolId: pool.userPoolId,
          });
          const identities = yield* IdentityPool("Identities", {
            allowUnauthenticatedIdentities: true,
            cognitoIdentityProviders: [
              {
                providerName: Output.interpolate`cognito-idp.us-west-2.amazonaws.com/${pool.userPoolId}`,
                clientId: client.clientId,
              },
            ],
            tags: { Environment: "test" },
          });
          return { pool, client, identities };
        }),
      );
      expect(updated.identities.identityPoolId).toBe(
        outputs.identities.identityPoolId,
      );

      const afterUpdate = yield* ci.describeIdentityPool({
        IdentityPoolId: outputs.identities.identityPoolId,
      });
      expect(afterUpdate.AllowUnauthenticatedIdentities).toBe(true);
      expect(afterUpdate.CognitoIdentityProviders).toHaveLength(1);

      yield* stack.destroy();
      yield* assertIdentityPoolDeleted(outputs.identities.identityPoolId);
    }),
  { timeout: 120_000 },
);

test.provider(
  "role attachment lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const identities = yield* IdentityPool("RolesPool", {
            allowUnauthenticatedIdentities: true,
          });
          const role = yield* Role("CognitoAuthRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Federated: "cognito-identity.amazonaws.com" },
                  Action: ["sts:AssumeRoleWithWebIdentity"],
                  Condition: {
                    StringEquals: {
                      "cognito-identity.amazonaws.com:aud":
                        identities.identityPoolId,
                    },
                  },
                },
              ],
            },
          });
          const attachment = yield* IdentityPoolRoleAttachment("Roles", {
            identityPoolId: identities.identityPoolId,
            roles: { authenticated: role.roleArn },
          });
          return { identities, role, attachment };
        }),
      );

      expect(outputs.attachment.roles.authenticated).toBe(outputs.role.roleArn);

      // out-of-band verification via distilled
      const observed = yield* ci.getIdentityPoolRoles({
        IdentityPoolId: outputs.identities.identityPoolId,
      });
      expect(observed.Roles?.authenticated).toBe(outputs.role.roleArn);

      yield* stack.destroy();
      yield* assertIdentityPoolDeleted(outputs.identities.identityPoolId);
    }),
  { timeout: 120_000 },
);
