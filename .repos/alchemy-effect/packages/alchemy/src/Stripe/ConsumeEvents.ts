import type * as cf from "@cloudflare/workers-types";
import { Webhooks } from "@distilled.cloud/stripe";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Worker, isWorkerEvent } from "../Cloudflare/Workers/Worker.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import {
  isRedactedMarker,
  sanitizeKey,
  unpackEnvValue,
  type RuntimeContext,
} from "../RuntimeContext.ts";
import type { StripeEventClass, StripeEventInstance } from "./Events.ts";
import { WebhookEndpoint } from "./WebhookEndpoint.ts";

export interface ConsumeEventsProps<
  E extends readonly StripeEventClass[] = readonly StripeEventClass[],
> {
  /**
   * Event classes to subscribe to. The handler `event` parameter is the
   * union of these classes.
   */
  events: E;
  /**
   * Path on the host Worker. Defaults to `/webhooks/stripe`.
   */
  path?: string;
}

export type SelectedStripeEvent<E extends readonly StripeEventClass[]> =
  InstanceType<E[number]>;

export const webhookPath = (path?: string): string =>
  path ?? "/webhooks/stripe";

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
 * Attach a webhook signing secret to a Worker as `secret_text`.
 *
 * {@link consumeEvents} calls this automatically for the endpoint it
 * provisions. Declare a {@link WebhookEndpoint} manually only when you need
 * a URL you already own; then bind the minted secret yourself.
 */
export const bindWebhookSecret = (
  host: Worker,
  secret: WebhookEndpoint["secret"],
  path?: string,
): Effect.Effect<void> =>
  host.bind(`stripe-webhook:${webhookPath(path)}`, {
    env: {
      [webhookSecretEnvName(path)]: secret,
    },
  });

/**
 * Subscribe to Stripe webhook events on the host Worker.
 *
 * `consumeEvents` provisions the {@link WebhookEndpoint} itself: it derives
 * the delivery URL from the Worker's `url`, enables the selected event
 * types, and binds the endpoint's minted signing secret onto the Worker so
 * deliveries are verified. No separate endpoint declaration is needed.
 *
 * Provide {@link ConsumeEventsLive} on the Worker Effect.
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
 */
export function consumeEvents<
  const E extends readonly StripeEventClass[],
  Req = never,
>(
  props: ConsumeEventsProps<E>,
  process: (
    event: SelectedStripeEvent<E>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents<
  const E extends readonly StripeEventClass[],
  Req = never,
>(
  id: string,
  props: ConsumeEventsProps<E>,
  process: (
    event: SelectedStripeEvent<E>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents(
  idOrProps: string | ConsumeEventsProps,
  propsOrProcess:
    | ConsumeEventsProps
    | ((event: StripeEventInstance) => Effect.Effect<void, never, any>),
  maybeProcess?: (
    event: StripeEventInstance,
  ) => Effect.Effect<void, never, any>,
): Effect.Effect<void, never, EventSource> {
  const [id, props, process] =
    typeof idOrProps === "string"
      ? [
          idOrProps,
          propsOrProcess as ConsumeEventsProps,
          maybeProcess as (
            event: StripeEventInstance,
          ) => Effect.Effect<void, never, any>,
        ]
      : [
          undefined,
          idOrProps as ConsumeEventsProps,
          propsOrProcess as (
            event: StripeEventInstance,
          ) => Effect.Effect<void, never, any>,
        ];
  return EventSource.use((source) =>
    source(id ?? webhookEndpointLogicalId(props.path), props, process),
  );
}

export type EventSourceService = <
  E extends readonly StripeEventClass[],
  Req = never,
>(
  id: string,
  props: ConsumeEventsProps<E>,
  process: (event: SelectedStripeEvent<E>) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class EventSource extends Context.Service<
  EventSource,
  EventSourceService
>()("Stripe.EventSource") {}

/**
 * Cloudflare Worker implementation of {@link consumeEvents}.
 *
 * Deploy-time: provisions a {@link WebhookEndpoint} pointing at this Worker
 * (at the subscribed path) and binds its minted signing secret onto the
 * Worker so deliveries can be verified. Runtime: registers a `fetch`
 * listener that claims requests on that path, verifies `Stripe-Signature`,
 * and runs the handler once per event.
 *
 * @layer
 * @provides Stripe.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* Worker;

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps,
      process: (
        event: StripeEventInstance,
      ) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props.path);
      const secretKey = webhookSecretEnvName(path);
      const byType = new Map(
        props.events.map((event) => [event.type, event] as const),
      );

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const endpoint = yield* WebhookEndpoint(id, {
              url: Output.interpolate`${host.url}${path}`,
              enabledEvents: [...props.events],
            });
            yield* bindWebhookSecret(host, endpoint.secret, props.path);
          }),
        );
      }

      yield* host.listen((event) => {
        if (!isWorkerEvent(event) || event.type !== "fetch") return;
        const request = event.input as cf.Request;
        let pathname: string;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          return;
        }
        if (pathname !== path) return;
        const env = (event.env ?? {}) as Record<string, unknown>;
        return handleDelivery(request, env, secretKey, byType, process);
      });
    }) as EventSourceService;
  }),
);

const asWebhookSecret = (
  raw: unknown,
): Redacted.Redacted<string> | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Redacted.isRedacted(raw)) {
    const value = Redacted.value(raw);
    return typeof value === "string" && value.length > 0
      ? (raw as Redacted.Redacted<string>)
      : undefined;
  }
  if (isRedactedMarker(raw) && typeof raw.value === "string") {
    return raw.value.length > 0 ? Redacted.make(raw.value) : undefined;
  }
  if (typeof raw === "string") return Redacted.make(raw);
  return undefined;
};

const handleDelivery = <Req>(
  request: cf.Request,
  env: Record<string, any>,
  secretKey: string,
  byType: Map<string, StripeEventClass>,
  process: (event: StripeEventInstance) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const payload = yield* Effect.promise(() =>
      (request as unknown as Request).text(),
    );
    const signature = request.headers.get("stripe-signature") ?? "";
    const resolved = asWebhookSecret(
      unpackEnvValue(env[secretKey] as string | undefined) ?? env[secretKey],
    );
    if (resolved === undefined) {
      return new Response("webhook secret missing", { status: 500 });
    }
    const parsed = yield* Webhooks.constructEvent({
      payload,
      signature,
      secret: Redacted.value(resolved),
    }).pipe(
      Effect.catchTag(
        ["StripeWebhookSignatureError", "StripeWebhookPayloadParseError"],
        () => Effect.succeed(undefined),
      ),
    );
    if (parsed === undefined) {
      return new Response("invalid signature", { status: 401 });
    }
    const Ctor = byType.get(parsed.type ?? "");
    if (Ctor === undefined) {
      return new Response(null, { status: 200 });
    }
    const data =
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      "object" in parsed.data
        ? (parsed.data as { object: unknown }).object
        : parsed.data;
    yield* process(new Ctor(data as never)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });
