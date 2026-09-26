import * as Schema from "effect/Schema";
import { ExtensionContentHash, ExtensionViewContext } from "./extensions.ts";

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));

/**
 * `t3.client/*` is the private, host-owned client-provider namespace. These
 * definitions are never registered with the public API broker, never appear in
 * discovery, and are never grantable — they are reachable only through the
 * connect-stream frames below.
 */
export const CLIENT_PROVIDER_API_ID_PATTERN = /^t3\.client\/[a-z][a-z0-9-]*$/;
export const ClientProviderApiId = Schema.String.check(
  Schema.isPattern(CLIENT_PROVIDER_API_ID_PATTERN),
);
export type ClientProviderApiId = typeof ClientProviderApiId.Type;

export const ClientProviderDescriptor = Schema.Struct({
  id: ClientProviderApiId,
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
});
export type ClientProviderDescriptor = typeof ClientProviderDescriptor.Type;

/** Sent once by the client when it opens the connect stream. */
export const ClientProvidersConnectInput = Schema.Struct({
  providers: Schema.Array(ClientProviderDescriptor).check(Schema.isMaxLength(16)),
});
export type ClientProvidersConnectInput = typeof ClientProvidersConnectInput.Type;

/** The caller identity the server forwards verbatim from the invoking envelope. */
export const ClientProviderCaller = Schema.Struct({
  installationId: Identity,
  contentHash: ExtensionContentHash,
  installationGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ClientProviderCaller = typeof ClientProviderCaller.Type;

const ClientProviderRegisteredFrame = Schema.Struct({
  type: Schema.Literal("registered"),
  connectionId: Identity,
  accepted: Schema.Array(ClientProviderDescriptor).check(Schema.isMaxLength(16)),
  rejected: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      reason: Schema.String.check(Schema.isMaxLength(400)),
    }),
  ),
});

const ClientProviderInvokeFrame = Schema.Struct({
  type: Schema.Literal("invoke"),
  requestId: Identity,
  apiId: ClientProviderApiId,
  method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  input: Schema.Json,
  context: ExtensionViewContext,
  caller: ClientProviderCaller,
  deadlineMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const ClientProviderCancelFrame = Schema.Struct({
  type: Schema.Literal("cancel"),
  requestId: Identity,
});

const ClientProviderSubscriptionOpenFrame = Schema.Struct({
  type: Schema.Literal("subscriptionOpen"),
  subscriptionId: Identity,
  apiId: ClientProviderApiId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  input: Schema.Json,
  context: ExtensionViewContext,
  caller: ClientProviderCaller,
});

const ClientProviderSubscriptionCloseFrame = Schema.Struct({
  type: Schema.Literal("subscriptionClose"),
  subscriptionId: Identity,
});

/** Every frame the server can put on a connection's connect stream. */
export const ClientProviderServerFrame = Schema.Union([
  ClientProviderRegisteredFrame,
  ClientProviderInvokeFrame,
  ClientProviderCancelFrame,
  ClientProviderSubscriptionOpenFrame,
  ClientProviderSubscriptionCloseFrame,
]);
export type ClientProviderServerFrame = typeof ClientProviderServerFrame.Type;

/** Unary response for an `invoke` frame. Carries no client-asserted identity. */
export const ClientProvidersRespondInput = Schema.Union([
  Schema.Struct({
    requestId: Identity,
    ok: Schema.Literal(true),
    value: Schema.Json,
  }),
  Schema.Struct({
    requestId: Identity,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
      message: Schema.String.check(Schema.isMaxLength(2000)),
    }),
  }),
]);
export type ClientProvidersRespondInput = typeof ClientProvidersRespondInput.Type;

/**
 * Client→server event. `correlationId` is a server-minted id the server already
 * recorded for the arriving socket — a `subscriptionId` (stream events) or a
 * `notificationId` (action/dismissal outcomes).
 */
export const ClientProviderEmitEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["snapshot", "data", "reset", "closed"]),
    value: Schema.Json,
  }),
  Schema.Struct({
    type: Schema.Literal("notificationOutcome"),
    outcome: Schema.Union([
      Schema.Struct({ actionId: Identity }),
      Schema.Struct({ dismissed: Schema.Literal(true) }),
    ]),
  }),
]);
export type ClientProviderEmitEvent = typeof ClientProviderEmitEvent.Type;

export const ClientProvidersEmitInput = Schema.Struct({
  correlationId: Identity,
  event: ClientProviderEmitEvent,
});
export type ClientProvidersEmitInput = typeof ClientProvidersEmitInput.Type;

/** Named seam error codes shared by server adapters and client providers. */
export const CLIENT_PROVIDER_ERROR_CODES = [
  "client-provider-unavailable",
  "client-target-required",
  "client-target-denied",
  "client-request-timeout",
  "client-event-overflow",
  "provider-rejected",
  "notification-expired",
  "notification-owner-mismatch",
] as const;
export type ClientProviderErrorCode = (typeof CLIENT_PROVIDER_ERROR_CODES)[number];

export class ClientProvidersError extends Schema.TaggedError<ClientProvidersError>()(
  "ClientProvidersError",
  {
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
    detail: Schema.String.check(Schema.isMaxLength(2000)),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `${this.code}: ${this.detail}`;
  }
}

/** One live client-provider connection as reported by `listClientTargets`. */
export const ClientTargetInfo = Schema.Struct({
  connectionId: Identity,
  announcedOrigin: Schema.optional(
    Schema.Struct({
      surface: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
      appVersion: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
      os: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
      deviceType: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
      connectionMethod: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
    }),
  ),
  providers: Schema.Array(ClientProviderDescriptor).check(Schema.isMaxLength(16)),
  connectedAt: Schema.String.check(Schema.isMaxLength(80)),
});
export type ClientTargetInfo = typeof ClientTargetInfo.Type;
