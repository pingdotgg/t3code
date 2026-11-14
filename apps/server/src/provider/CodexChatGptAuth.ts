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
import type { CodexChatGptCredentials } from "./CodexChatGptAuth-part2.ts";
import { DISCOVERY, Discovery, REQUIRED_SCOPE, RESOURCE, Record, Registration, RegistrationProfiles, Sessions, TokenResponse, decodeDiscoveryEffect, decodeOAuthError, decodeRegistration, decodeSessions, decodeTokens, encodeRegistration, encodeSessions, isSetupError, profileMethodId, sessionLocks } from "./CodexChatGptAuth-part2.ts";


import type { CodexChatGptAuthOptions } from "./CodexChatGptAuth-part3.ts";
import { makeCodexChatGptAuthState } from "./CodexChatGptAuth-part3.ts";
import { makeCodexChatGptAuthFlows } from "./CodexChatGptAuth-part4.ts";

export type { CodexChatGptAuthOptions };

export const makeCodexChatGptAuth = Effect.fn("makeCodexChatGptAuth")(function* (
  options: CodexChatGptAuthOptions,
) {
  const state = yield* makeCodexChatGptAuthState(options);
  return yield* makeCodexChatGptAuthFlows(state);
});
export * from "./CodexChatGptAuth-part2.ts";
