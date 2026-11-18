import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { IdentityPool } from "./IdentityPool.ts";
import { IdentityPoolAdmin, type IdentityPoolAdminClient } from "./IdentityPoolAdmin.ts";

/** The injected identifier field, in the distilled wire type. */
type IdentityPoolIdField = Pick<ci.ListIdentitiesInput, "IdentityPoolId">;

/**
 * HTTP implementation of {@link IdentityPoolAdmin}: grants the
 * `cognito-identity:*` identity-management actions on the bound pool's ARN
 * and calls the Cognito Identity HTTP API with the function's IAM
 * credentials.
 */
export const IdentityPoolAdminHttp = Layer.effect(
  IdentityPoolAdmin,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeIdentity = yield* AWSBindings.withCredentials(ci.describeIdentity);
    const listIdentities = yield* AWSBindings.withCredentials(ci.listIdentities);
    const deleteIdentities = yield* AWSBindings.withCredentials(ci.deleteIdentities);
    const lookupDeveloperIdentity = yield* AWSBindings.withCredentials(ci.lookupDeveloperIdentity);
    const mergeDeveloperIdentities = yield* AWSBindings.withCredentials(
      ci.mergeDeveloperIdentities,
    );
    const unlinkDeveloperIdentity = yield* AWSBindings.withCredentials(ci.unlinkDeveloperIdentity);
    const getOpenIdTokenForDeveloperIdentity = yield* AWSBindings.withCredentials(
      ci.getOpenIdTokenForDeveloperIdentity,
    );

    return Effect.fn(function* <P extends IdentityPool>(pool: P) {
      const IdentityPoolId = yield* pool.identityPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Cognito.IdentityPoolAdmin(${pool})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "cognito-identity:GetOpenIdTokenForDeveloperIdentity",
                "cognito-identity:ListIdentities",
                "cognito-identity:LookupDeveloperIdentity",
                "cognito-identity:MergeDeveloperIdentities",
                "cognito-identity:UnlinkDeveloperIdentity",
              ],
              Resource: [pool.identityPoolArn],
            },
            {
              Effect: "Allow",
              // These act on identity IDs, which have no ARN form —
              // Cognito Identity does not support resource-level
              // scoping for them.
              Action: ["cognito-identity:DeleteIdentities", "cognito-identity:DescribeIdentity"],
              Resource: ["*"],
            },
          ],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.IdentityPoolAdmin", pool.LogicalId);
      const withPool = methods.injecting(
        Effect.map(IdentityPoolId, (id): IdentityPoolIdField => ({
          IdentityPoolId: id,
        })),
      );
      const adminClient: IdentityPoolAdminClient = {
        describeIdentity: methods.plain("describeIdentity", describeIdentity),
        deleteIdentities: methods.plain("deleteIdentities", deleteIdentities),
        listIdentities: withPool("listIdentities", listIdentities),
        lookupDeveloperIdentity: withPool("lookupDeveloperIdentity", lookupDeveloperIdentity),
        mergeDeveloperIdentities: withPool("mergeDeveloperIdentities", mergeDeveloperIdentities),
        unlinkDeveloperIdentity: withPool("unlinkDeveloperIdentity", unlinkDeveloperIdentity),
        getOpenIdTokenForDeveloperIdentity: withPool(
          "getOpenIdTokenForDeveloperIdentity",
          getOpenIdTokenForDeveloperIdentity,
        ),
      };
      return adminClient;
    });
  }),
);
