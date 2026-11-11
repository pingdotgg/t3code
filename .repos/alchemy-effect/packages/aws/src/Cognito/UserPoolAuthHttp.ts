import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import { UserPoolAuth, type UserPoolAuthClient } from "./UserPoolAuth.ts";
import type { UserPoolClient } from "./UserPoolClient.ts";

/** The injected identifier field, in the distilled wire type (Cognito marks
 * `ClientId` sensitive, so the field accepts `string | Redacted<string>`). */
type ClientIdField = Pick<cip.SignUpRequest, "ClientId">;

/**
 * HTTP implementation of {@link UserPoolAuth}. The token-based auth-flow
 * operations are unauthenticated (Cognito does not evaluate IAM for them),
 * so the deploy-time half only records the binding — no policy statements
 * are attached.
 */
export const UserPoolAuthHttp = Layer.effect(
  UserPoolAuth,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const signUp = yield* AWSBindings.withCredentials(cip.signUp);
    const confirmSignUp = yield* AWSBindings.withCredentials(cip.confirmSignUp);
    const resendConfirmationCode = yield* AWSBindings.withCredentials(cip.resendConfirmationCode);
    const initiateAuth = yield* AWSBindings.withCredentials(cip.initiateAuth);
    const respondToAuthChallenge = yield* AWSBindings.withCredentials(cip.respondToAuthChallenge);
    const forgotPassword = yield* AWSBindings.withCredentials(cip.forgotPassword);
    const confirmForgotPassword = yield* AWSBindings.withCredentials(cip.confirmForgotPassword);
    const getUser = yield* AWSBindings.withCredentials(cip.getUser);
    const globalSignOut = yield* AWSBindings.withCredentials(cip.globalSignOut);
    const revokeToken = yield* AWSBindings.withCredentials(cip.revokeToken);
    const getTokensFromRefreshToken = yield* AWSBindings.withCredentials(
      cip.getTokensFromRefreshToken,
    );
    const changePassword = yield* AWSBindings.withCredentials(cip.changePassword);
    const updateUserAttributes = yield* AWSBindings.withCredentials(cip.updateUserAttributes);
    const deleteUserAttributes = yield* AWSBindings.withCredentials(cip.deleteUserAttributes);
    const getUserAttributeVerificationCode = yield* AWSBindings.withCredentials(
      cip.getUserAttributeVerificationCode,
    );
    const verifyUserAttribute = yield* AWSBindings.withCredentials(cip.verifyUserAttribute);
    const setUserMFAPreference = yield* AWSBindings.withCredentials(cip.setUserMFAPreference);
    const associateSoftwareToken = yield* AWSBindings.withCredentials(cip.associateSoftwareToken);
    const verifySoftwareToken = yield* AWSBindings.withCredentials(cip.verifySoftwareToken);
    const getUserAuthFactors = yield* AWSBindings.withCredentials(cip.getUserAuthFactors);
    const deleteUser = yield* AWSBindings.withCredentials(cip.deleteUser);

    return Effect.fn(function* <C extends UserPoolClient>(client: C) {
      const ClientId = yield* client.clientId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // No IAM is required for the public auth flows; the binding is
        // recorded so the app client deploys before the function.
        yield* bind`AWS.Cognito.UserPoolAuth(${client})`({
          policyStatements: [],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.UserPoolAuth", client.LogicalId);
      const withClient = methods.injecting(
        Effect.map(ClientId, (id): ClientIdField => ({ ClientId: id })),
      );
      const authClient: UserPoolAuthClient = {
        // client-scoped flows — the app client ID is injected
        signUp: withClient("signUp", signUp),
        confirmSignUp: withClient("confirmSignUp", confirmSignUp),
        resendConfirmationCode: withClient("resendConfirmationCode", resendConfirmationCode),
        initiateAuth: withClient("initiateAuth", initiateAuth),
        respondToAuthChallenge: withClient("respondToAuthChallenge", respondToAuthChallenge),
        forgotPassword: withClient("forgotPassword", forgotPassword),
        confirmForgotPassword: withClient("confirmForgotPassword", confirmForgotPassword),
        revokeToken: withClient("revokeToken", revokeToken),
        getTokensFromRefreshToken: withClient(
          "getTokensFromRefreshToken",
          getTokensFromRefreshToken,
        ),
        // token-scoped self-service — authorized by the access token itself
        getUser: methods.plain("getUser", getUser),
        globalSignOut: methods.plain("globalSignOut", globalSignOut),
        changePassword: methods.plain("changePassword", changePassword),
        updateUserAttributes: methods.plain("updateUserAttributes", updateUserAttributes),
        deleteUserAttributes: methods.plain("deleteUserAttributes", deleteUserAttributes),
        getUserAttributeVerificationCode: methods.plain(
          "getUserAttributeVerificationCode",
          getUserAttributeVerificationCode,
        ),
        verifyUserAttribute: methods.plain("verifyUserAttribute", verifyUserAttribute),
        setUserMFAPreference: methods.plain("setUserMFAPreference", setUserMFAPreference),
        associateSoftwareToken: methods.plain("associateSoftwareToken", associateSoftwareToken),
        verifySoftwareToken: methods.plain("verifySoftwareToken", verifySoftwareToken),
        getUserAuthFactors: methods.plain("getUserAuthFactors", getUserAuthFactors),
        deleteUser: methods.plain("deleteUser", deleteUser),
      };
      return authClient;
    });
  }),
);
