import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { IdentityPool } from "./IdentityPool.ts";
import {
  IdentityPoolAuth,
  type GetIdRequest,
  type IdentityPoolAuthClient,
} from "./IdentityPoolAuth.ts";

/**
 * HTTP implementation of {@link IdentityPoolAuth}. The credentials-vending
 * flows are unauthenticated (Cognito does not evaluate IAM for them), so the
 * deploy-time half only records the binding — no policy statements are
 * attached.
 */
export const IdentityPoolAuthHttp = Layer.effect(
  IdentityPoolAuth,
  Effect.gen(function* () {
    const getId = yield* ci.getId;
    const getCredentialsForIdentity = yield* ci.getCredentialsForIdentity;
    const getOpenIdToken = yield* ci.getOpenIdToken;
    const unlinkIdentity = yield* ci.unlinkIdentity;

    return Effect.fn(function* <P extends IdentityPool>(pool: P) {
      const IdentityPoolId = yield* pool.identityPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // No IAM is required for the public identity flows; the binding is
          // recorded so the identity pool deploys before the function.
          yield* host.bind`Allow(${host}, AWS.Cognito.IdentityPoolAuth(${pool}))`(
            { policyStatements: [] },
          );
        }
      }
      const methods = cognitoMethods(
        "AWS.Cognito.IdentityPoolAuth",
        pool.LogicalId,
      );
      const authClient: IdentityPoolAuthClient = {
        // optional-request operation stays bespoke (the helper's wrapped
        // methods take a required request object)
        getId: Effect.fn(
          `AWS.Cognito.IdentityPoolAuth.getId(${pool.LogicalId})`,
        )(function* (request: GetIdRequest = {}) {
          return yield* getId({
            ...request,
            IdentityPoolId: yield* IdentityPoolId,
          });
        }),
        getCredentialsForIdentity: methods.plain(
          "getCredentialsForIdentity",
          getCredentialsForIdentity,
        ),
        getOpenIdToken: methods.plain("getOpenIdToken", getOpenIdToken),
        unlinkIdentity: methods.plain("unlinkIdentity", unlinkIdentity),
      };
      return authClient;
    });
  }),
);
