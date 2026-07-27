import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
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
    const signUp = yield* cip.signUp;
    const confirmSignUp = yield* cip.confirmSignUp;
    const resendConfirmationCode = yield* cip.resendConfirmationCode;
    const initiateAuth = yield* cip.initiateAuth;
    const respondToAuthChallenge = yield* cip.respondToAuthChallenge;
    const forgotPassword = yield* cip.forgotPassword;
    const confirmForgotPassword = yield* cip.confirmForgotPassword;
    const getUser = yield* cip.getUser;
    const globalSignOut = yield* cip.globalSignOut;
    const revokeToken = yield* cip.revokeToken;
    const getTokensFromRefreshToken = yield* cip.getTokensFromRefreshToken;
    const changePassword = yield* cip.changePassword;
    const updateUserAttributes = yield* cip.updateUserAttributes;
    const deleteUserAttributes = yield* cip.deleteUserAttributes;
    const getUserAttributeVerificationCode =
      yield* cip.getUserAttributeVerificationCode;
    const verifyUserAttribute = yield* cip.verifyUserAttribute;
    const setUserMFAPreference = yield* cip.setUserMFAPreference;
    const associateSoftwareToken = yield* cip.associateSoftwareToken;
    const verifySoftwareToken = yield* cip.verifySoftwareToken;
    const getUserAuthFactors = yield* cip.getUserAuthFactors;
    const deleteUser = yield* cip.deleteUser;

    return Effect.fn(function* <C extends UserPoolClient>(client: C) {
      const ClientId = yield* client.clientId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // No IAM is required for the public auth flows; the binding is
          // recorded so the app client deploys before the function.
          yield* host.bind`Allow(${host}, AWS.Cognito.UserPoolAuth(${client}))`(
            { policyStatements: [] },
          );
        }
      }
      const methods = cognitoMethods(
        "AWS.Cognito.UserPoolAuth",
        client.LogicalId,
      );
      const withClient = methods.injecting(
        Effect.map(ClientId, (id): ClientIdField => ({ ClientId: id })),
      );
      const authClient: UserPoolAuthClient = {
        // client-scoped flows — the app client ID is injected
        signUp: withClient("signUp", signUp),
        confirmSignUp: withClient("confirmSignUp", confirmSignUp),
        resendConfirmationCode: withClient(
          "resendConfirmationCode",
          resendConfirmationCode,
        ),
        initiateAuth: withClient("initiateAuth", initiateAuth),
        respondToAuthChallenge: withClient(
          "respondToAuthChallenge",
          respondToAuthChallenge,
        ),
        forgotPassword: withClient("forgotPassword", forgotPassword),
        confirmForgotPassword: withClient(
          "confirmForgotPassword",
          confirmForgotPassword,
        ),
        revokeToken: withClient("revokeToken", revokeToken),
        getTokensFromRefreshToken: withClient(
          "getTokensFromRefreshToken",
          getTokensFromRefreshToken,
        ),
        // token-scoped self-service — authorized by the access token itself
        getUser: methods.plain("getUser", getUser),
        globalSignOut: methods.plain("globalSignOut", globalSignOut),
        changePassword: methods.plain("changePassword", changePassword),
        updateUserAttributes: methods.plain(
          "updateUserAttributes",
          updateUserAttributes,
        ),
        deleteUserAttributes: methods.plain(
          "deleteUserAttributes",
          deleteUserAttributes,
        ),
        getUserAttributeVerificationCode: methods.plain(
          "getUserAttributeVerificationCode",
          getUserAttributeVerificationCode,
        ),
        verifyUserAttribute: methods.plain(
          "verifyUserAttribute",
          verifyUserAttribute,
        ),
        setUserMFAPreference: methods.plain(
          "setUserMFAPreference",
          setUserMFAPreference,
        ),
        associateSoftwareToken: methods.plain(
          "associateSoftwareToken",
          associateSoftwareToken,
        ),
        verifySoftwareToken: methods.plain(
          "verifySoftwareToken",
          verifySoftwareToken,
        ),
        getUserAuthFactors: methods.plain(
          "getUserAuthFactors",
          getUserAuthFactors,
        ),
        deleteUser: methods.plain("deleteUser", deleteUser),
      };
      return authClient;
    });
  }),
);
