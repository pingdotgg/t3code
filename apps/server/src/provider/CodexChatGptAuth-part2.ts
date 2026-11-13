// @effect-diagnostics nodeBuiltinImport:off - OAuth loopback listener and PKCE use Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ProviderSetupError,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { openAiUserId } from "../telemetry/Identify.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import { codexAuthCallbackPage, codexAuthReturnUrl } from "./CodexAuthCallbackPage.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderAuthFlowContext } from "@t3tools/provider-core/server/providerAuthFlow";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export const isSetupError = Schema.is(ProviderSetupError);
export const RESOURCE = "https://api.openai.com/v1";
export const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
export const DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration";
export const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  id_token: Schema.optionalKey(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
  earliest_refresh_at: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});
export const Record = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.Finite,
  earliestRefreshAt: Schema.NullOr(Schema.Finite),
  scopes: Schema.Array(Schema.String),
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  idToken: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});
export type CodexChatGptCredentials = typeof Record.Type;
export const Sessions = Schema.Struct({
  activeClientId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Record),
});
export const sessionLocks = new WeakMap<
  typeof ServerSecretStore.ServerSecretStore.Service,
  Map<string, Semaphore.Semaphore>
>();
export const Registration = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^oaiapp_/u)),
  subject: Schema.optionalKey(Schema.String),
  connectionLabel: Schema.optionalKey(Schema.String),
  sharingEnabled: Schema.optionalKey(Schema.Boolean),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}\/auth\/callback$/u),
    ),
  ),
});
export const RegistrationProfiles = Schema.Struct({
  profiles: Schema.Array(Registration),
  lastClientId: Schema.NullOr(Schema.String),
});
export const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([RegistrationProfiles, Registration])),
);
export const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(RegistrationProfiles));
export const profileMethodId = (clientId: string) => `chatgpt-profile:${clientId}`;
export const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.String),
});
export const OAuthError = Schema.Struct({ error: Schema.String });
export const decodeSessions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Sessions, Record])),
);
export const encodeSessions = Schema.encodeEffect(Schema.fromJsonString(Sessions));
export const decodeTokens = Schema.decodeUnknownSync(TokenResponse);
export const decodeDiscoveryEffect = Schema.decodeUnknownEffect(Discovery);
export const decodeOAuthError = Schema.decodeUnknownSync(OAuthError);

