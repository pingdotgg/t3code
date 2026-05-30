import {
  AuthSessionId,
  ServerPushSubscriptionRecord,
  WebPushSubscriptionJson,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WebPushSubscriptionRepositoryError } from "../Errors.ts";

export const UpsertWebPushSubscriptionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subscription: WebPushSubscriptionJson,
  userAgent: Schema.NullOr(Schema.String),
  now: Schema.DateTimeUtcFromString,
});
export type UpsertWebPushSubscriptionInput = typeof UpsertWebPushSubscriptionInput.Type;

export const RemoveWebPushSubscriptionInput = Schema.Struct({
  sessionId: AuthSessionId,
  endpoint: Schema.String,
});
export type RemoveWebPushSubscriptionInput = typeof RemoveWebPushSubscriptionInput.Type;

export const ListActiveWebPushSubscriptionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveWebPushSubscriptionsInput = typeof ListActiveWebPushSubscriptionsInput.Type;

export const MarkWebPushSubscriptionSuccessInput = Schema.Struct({
  endpoint: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type MarkWebPushSubscriptionSuccessInput = typeof MarkWebPushSubscriptionSuccessInput.Type;

export const MarkWebPushSubscriptionFailureInput = Schema.Struct({
  endpoint: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type MarkWebPushSubscriptionFailureInput = typeof MarkWebPushSubscriptionFailureInput.Type;

export const DisableWebPushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type DisableWebPushSubscriptionInput = typeof DisableWebPushSubscriptionInput.Type;

export interface WebPushSubscriptionRepositoryShape {
  readonly upsert: (
    input: UpsertWebPushSubscriptionInput,
  ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  readonly removeByEndpointForSession: (
    input: RemoveWebPushSubscriptionInput,
  ) => Effect.Effect<boolean, WebPushSubscriptionRepositoryError>;
  readonly listActive: (
    input: ListActiveWebPushSubscriptionsInput,
  ) => Effect.Effect<
    ReadonlyArray<ServerPushSubscriptionRecord>,
    WebPushSubscriptionRepositoryError
  >;
  readonly markSuccess: (
    input: MarkWebPushSubscriptionSuccessInput,
  ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  readonly markFailure: (
    input: MarkWebPushSubscriptionFailureInput,
  ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  readonly disable: (
    input: DisableWebPushSubscriptionInput,
  ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
}

export class WebPushSubscriptionRepository extends Context.Service<
  WebPushSubscriptionRepository,
  WebPushSubscriptionRepositoryShape
>()("salchi/persistence/Services/WebPushSubscriptions/WebPushSubscriptionRepository") {}
