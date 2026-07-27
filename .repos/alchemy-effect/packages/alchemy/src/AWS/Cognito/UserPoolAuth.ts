import type * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UserPoolClient } from "./UserPoolClient.ts";

export interface SignUpRequest extends Omit<cip.SignUpRequest, "ClientId"> {}
export interface ConfirmSignUpRequest extends Omit<
  cip.ConfirmSignUpRequest,
  "ClientId"
> {}
export interface ResendConfirmationCodeRequest extends Omit<
  cip.ResendConfirmationCodeRequest,
  "ClientId"
> {}
export interface InitiateAuthRequest extends Omit<
  cip.InitiateAuthRequest,
  "ClientId"
> {}
export interface RespondToAuthChallengeRequest extends Omit<
  cip.RespondToAuthChallengeRequest,
  "ClientId"
> {}
export interface ForgotPasswordRequest extends Omit<
  cip.ForgotPasswordRequest,
  "ClientId"
> {}
export interface ConfirmForgotPasswordRequest extends Omit<
  cip.ConfirmForgotPasswordRequest,
  "ClientId"
> {}
export interface RevokeTokenRequest extends Omit<
  cip.RevokeTokenRequest,
  "ClientId" | "ClientSecret"
> {}
export interface GetTokensFromRefreshTokenRequest extends Omit<
  cip.GetTokensFromRefreshTokenRequest,
  "ClientId"
> {}

/**
 * The typed client returned by binding {@link UserPoolAuth} to a
 * `UserPoolClient`. Every method automatically injects the app client ID.
 */
export interface UserPoolAuthClient {
  /** Register a new user (public sign-up flow). */
  signUp: (
    request: SignUpRequest,
  ) => Effect.Effect<cip.SignUpResponse, cip.SignUpError>;
  /** Confirm a sign-up with the emailed/SMSed confirmation code. */
  confirmSignUp: (
    request: ConfirmSignUpRequest,
  ) => Effect.Effect<cip.ConfirmSignUpResponse, cip.ConfirmSignUpError>;
  /** Resend the sign-up confirmation code. */
  resendConfirmationCode: (
    request: ResendConfirmationCodeRequest,
  ) => Effect.Effect<
    cip.ResendConfirmationCodeResponse,
    cip.ResendConfirmationCodeError
  >;
  /** Start an authentication flow (e.g. `USER_PASSWORD_AUTH`). */
  initiateAuth: (
    request: InitiateAuthRequest,
  ) => Effect.Effect<cip.InitiateAuthResponse, cip.InitiateAuthError>;
  /** Answer an auth challenge returned by `initiateAuth`. */
  respondToAuthChallenge: (
    request: RespondToAuthChallengeRequest,
  ) => Effect.Effect<
    cip.RespondToAuthChallengeResponse,
    cip.RespondToAuthChallengeError
  >;
  /** Start the forgot-password flow. */
  forgotPassword: (
    request: ForgotPasswordRequest,
  ) => Effect.Effect<cip.ForgotPasswordResponse, cip.ForgotPasswordError>;
  /** Complete the forgot-password flow with the confirmation code. */
  confirmForgotPassword: (
    request: ConfirmForgotPasswordRequest,
  ) => Effect.Effect<
    cip.ConfirmForgotPasswordResponse,
    cip.ConfirmForgotPasswordError
  >;
  /** Fetch the signed-in user's profile from an access token. */
  getUser: (
    request: cip.GetUserRequest,
  ) => Effect.Effect<cip.GetUserResponse, cip.GetUserError>;
  /** Sign the user out of all devices (invalidates tokens). */
  globalSignOut: (
    request: cip.GlobalSignOutRequest,
  ) => Effect.Effect<cip.GlobalSignOutResponse, cip.GlobalSignOutError>;
  /** Revoke a refresh token and all access tokens derived from it. */
  revokeToken: (
    request: RevokeTokenRequest,
  ) => Effect.Effect<cip.RevokeTokenResponse, cip.RevokeTokenError>;
  /** Exchange a refresh token for fresh access/ID tokens (refresh-token
   * rotation aware). */
  getTokensFromRefreshToken: (
    request: GetTokensFromRefreshTokenRequest,
  ) => Effect.Effect<
    cip.GetTokensFromRefreshTokenResponse,
    cip.GetTokensFromRefreshTokenError
  >;
  /** Change the signed-in user's password. */
  changePassword: (
    request: cip.ChangePasswordRequest,
  ) => Effect.Effect<cip.ChangePasswordResponse, cip.ChangePasswordError>;
  /** Update the signed-in user's attributes. */
  updateUserAttributes: (
    request: cip.UpdateUserAttributesRequest,
  ) => Effect.Effect<
    cip.UpdateUserAttributesResponse,
    cip.UpdateUserAttributesError
  >;
  /** Delete attributes from the signed-in user's profile. */
  deleteUserAttributes: (
    request: cip.DeleteUserAttributesRequest,
  ) => Effect.Effect<
    cip.DeleteUserAttributesResponse,
    cip.DeleteUserAttributesError
  >;
  /** Send a verification code for an updated attribute (email/phone). */
  getUserAttributeVerificationCode: (
    request: cip.GetUserAttributeVerificationCodeRequest,
  ) => Effect.Effect<
    cip.GetUserAttributeVerificationCodeResponse,
    cip.GetUserAttributeVerificationCodeError
  >;
  /** Verify an attribute with the code delivered to it. */
  verifyUserAttribute: (
    request: cip.VerifyUserAttributeRequest,
  ) => Effect.Effect<
    cip.VerifyUserAttributeResponse,
    cip.VerifyUserAttributeError
  >;
  /** Set the signed-in user's MFA preferences (SMS / TOTP / email). */
  setUserMFAPreference: (
    request: cip.SetUserMFAPreferenceRequest,
  ) => Effect.Effect<
    cip.SetUserMFAPreferenceResponse,
    cip.SetUserMFAPreferenceError
  >;
  /** Begin TOTP enrollment: returns the shared secret to seed the
   * authenticator app. */
  associateSoftwareToken: (
    request: cip.AssociateSoftwareTokenRequest,
  ) => Effect.Effect<
    cip.AssociateSoftwareTokenResponse,
    cip.AssociateSoftwareTokenError
  >;
  /** Complete TOTP enrollment by verifying a generated code. */
  verifySoftwareToken: (
    request: cip.VerifySoftwareTokenRequest,
  ) => Effect.Effect<
    cip.VerifySoftwareTokenResponse,
    cip.VerifySoftwareTokenError
  >;
  /** List the auth factors configured for the signed-in user. */
  getUserAuthFactors: (
    request: cip.GetUserAuthFactorsRequest,
  ) => Effect.Effect<
    cip.GetUserAuthFactorsResponse,
    cip.GetUserAuthFactorsError
  >;
  /** Delete the signed-in user's own account. */
  deleteUser: (
    request: cip.DeleteUserRequest,
  ) => Effect.Effect<cip.DeleteUserResponse, cip.DeleteUserError>;
}

/**
 * Runtime binding for the public (client-side) Cognito user pool auth flows.
 *
 * Bind this to a `UserPoolClient` inside a function runtime to get a typed
 * client for sign-up, sign-in, and token flows. These operations are
 * unauthenticated (Cognito does not evaluate IAM for them), so the binding
 * grants no IAM policy — it injects the app client ID into every call.
 * @binding
 * @section Authenticating Users
 * @example Username/Password Sign-In
 * ```typescript
 * const auth = yield* Cognito.UserPoolAuth(client);
 *
 * const result = yield* auth.initiateAuth({
 *   AuthFlow: "USER_PASSWORD_AUTH",
 *   AuthParameters: { USERNAME: username, PASSWORD: password },
 * });
 * const idToken = result.AuthenticationResult?.IdToken;
 * ```
 *
 * @example Sign-Up and Confirmation
 * ```typescript
 * yield* auth.signUp({
 *   Username: "user@example.com",
 *   Password: "Sup3r-secret!",
 *   UserAttributes: [{ Name: "email", Value: "user@example.com" }],
 * });
 * yield* auth.confirmSignUp({
 *   Username: "user@example.com",
 *   ConfirmationCode: code,
 * });
 * ```
 *
 * @example Read the Signed-In User
 * ```typescript
 * const user = yield* auth.getUser({ AccessToken: accessToken });
 * ```
 *
 * @section Self-Service Account Management
 * @example Change Password and Update Attributes
 * ```typescript
 * yield* auth.changePassword({
 *   AccessToken: accessToken,
 *   PreviousPassword: oldPassword,
 *   ProposedPassword: newPassword,
 * });
 * yield* auth.updateUserAttributes({
 *   AccessToken: accessToken,
 *   UserAttributes: [{ Name: "nickname", Value: "sam" }],
 * });
 * ```
 *
 * @example Refresh Tokens
 * ```typescript
 * const refreshed = yield* auth.getTokensFromRefreshToken({
 *   RefreshToken: refreshToken,
 * });
 * ```
 */
export interface UserPoolAuth extends Binding.Service<
  UserPoolAuth,
  "AWS.Cognito.UserPoolAuth",
  <C extends UserPoolClient>(client: C) => Effect.Effect<UserPoolAuthClient>
> {}
export const UserPoolAuth = Binding.Service<UserPoolAuth>(
  "AWS.Cognito.UserPoolAuth",
);
