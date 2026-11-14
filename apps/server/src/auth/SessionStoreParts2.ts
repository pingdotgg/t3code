import {
  AuthSessionId,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  AuthWebSocketTicketUse,
  RuntimeMode,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";
import { toClientMetadata } from "./SessionStoreParts.ts";
import { InvalidSessionExpirationClaimError, InvalidSessionTokenPayloadError, InvalidSessionTokenSignatureError, InvalidWebSocketTokenPayloadError, InvalidWebSocketTokenSignatureError, MalformedSessionTokenError, MalformedWebSocketTokenError, SessionTokenExpiredError, SessionTokenRevokedError, UnknownSessionTokenError, UnknownWebSocketSessionError, WebSocketSessionExpiredError, WebSocketSessionRevokedError, WebSocketTokenExpiredError } from "./SessionStore.ts";


