import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, RunId, ThreadId } from "./baseSchemas.ts";

const EndpointId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
const SubscriptionId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const RunWebhookInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("subscribe"),
    endpointId: EndpointId,
    threadId: ThreadId,
    runId: RunId,
  }),
  Schema.Struct({ action: Schema.Literal("read"), subscriptionId: SubscriptionId }),
  Schema.Struct({ action: Schema.Literal("cancel"), subscriptionId: SubscriptionId }),
  Schema.Struct({ action: Schema.Literal("retry"), subscriptionId: SubscriptionId }),
]);
export type RunWebhookInput = typeof RunWebhookInput.Type;

export const RunWebhookResult = Schema.Struct({
  subscriptionId: SubscriptionId,
  threadId: ThreadId,
  runId: RunId,
  state: Schema.Literals(["active", "delivered", "failed", "cancelled", "expired"]),
  attempts: Schema.Number,
  expiresAt: IsoDateTime,
});
export type RunWebhookResult = typeof RunWebhookResult.Type;

export const RunWebhookPayload = Schema.Struct({
  version: Schema.Literal(1),
  deliveryId: Schema.String,
  subscriptionId: SubscriptionId,
  threadId: ThreadId,
  runId: RunId,
  status: Schema.Literals([
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
  ]),
  observedAt: IsoDateTime,
  link: Schema.String,
  lastMessage: Schema.NullOr(
    Schema.Struct({
      id: MessageId,
      runId: Schema.NullOr(RunId),
      role: Schema.Literals(["user", "assistant", "system"]),
      updatedAt: IsoDateTime,
    }),
  ),
});
export type RunWebhookPayload = typeof RunWebhookPayload.Type;
