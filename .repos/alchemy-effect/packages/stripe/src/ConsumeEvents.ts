import { sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { StripeEventClass, StripeEventInstance } from "./Events.ts";

export interface ConsumeEventsProps<
  E extends readonly StripeEventClass[] = readonly StripeEventClass[],
> {
  /**
   * Event classes to subscribe to. The handler `event` parameter is the
   * union of these classes.
   */
  events: E;
  /**
   * Path on the host. Defaults to `/webhooks/stripe`.
   */
  path?: string;
}

export type SelectedStripeEvent<E extends readonly StripeEventClass[]> = InstanceType<E[number]>;

export const webhookPath = (path?: string): string => path ?? "/webhooks/stripe";

export const webhookSecretEnvName = (path?: string): string =>
  `STRIPE_WEBHOOK_SECRET_${webhookPath(path).replaceAll(/[^a-zA-Z0-9]/g, "_")}`;

/**
 * Deterministic logical id for the {@link WebhookEndpoint} created by
 * {@link consumeEvents} when the caller does not pass an explicit id.
 * Derived from the delivery path so two subscriptions on different paths
 * don't collide.
 */
export const webhookEndpointLogicalId = (path?: string): string =>
  `WebhookEndpoint${sanitizeKey(webhookPath(path))}`;

/**
 * Subscribe to Stripe webhook events on the host.
 *
 * `consumeEvents` provisions the {@link WebhookEndpoint} itself: it derives
 * the delivery URL from the host's `url`, enables the selected event
 * types, and binds the endpoint's minted signing secret onto the host so
 * deliveries are verified. No separate endpoint declaration is needed.
 *
 * Provide `Stripe.ConsumeEventsLive` on the host's Effect, e.g. a Cloudflare
 * Worker.
 *
 * ### Handling events
 * **Example:** Customer created and invoice paid
 * ```typescript
 * yield* Stripe.consumeEvents("Events", {
 *   events: [Stripe.CustomerCreated, Stripe.InvoicePaid],
 * }, Effect.fn(function* (event) {
 *   // event: CustomerCreated | InvoicePaid
 *   yield* Effect.log(event.type);
 * }));
 * ```
 *
 * @binding
 * @product Webhook
 */
export function consumeEvents<const E extends readonly StripeEventClass[], Req = never>(
  props: ConsumeEventsProps<E>,
  process: (event: SelectedStripeEvent<E>) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents<const E extends readonly StripeEventClass[], Req = never>(
  id: string,
  props: ConsumeEventsProps<E>,
  process: (event: SelectedStripeEvent<E>) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents(
  idOrProps: string | ConsumeEventsProps,
  propsOrProcess:
    | ConsumeEventsProps
    | ((event: StripeEventInstance) => Effect.Effect<void, never, any>),
  maybeProcess?: (event: StripeEventInstance) => Effect.Effect<void, never, any>,
): Effect.Effect<void, never, EventSource> {
  const [id, props, process] =
    typeof idOrProps === "string"
      ? [
          idOrProps,
          propsOrProcess as ConsumeEventsProps,
          maybeProcess as (event: StripeEventInstance) => Effect.Effect<void, never, any>,
        ]
      : [
          undefined,
          idOrProps as ConsumeEventsProps,
          propsOrProcess as (event: StripeEventInstance) => Effect.Effect<void, never, any>,
        ];
  return EventSource.use((source) =>
    source(id ?? webhookEndpointLogicalId(props.path), props, process),
  );
}

export type EventSourceService = <E extends readonly StripeEventClass[], Req = never>(
  id: string,
  props: ConsumeEventsProps<E>,
  process: (event: SelectedStripeEvent<E>) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class EventSource extends Context.Service<EventSource, EventSourceService>()(
  "Stripe.EventSource",
) {}
