import { Webhooks } from "@distilled.cloud/stripe";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isRedactedMarker, RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  EventSource,
  webhookPath,
  webhookSecretEnvName,
  type ConsumeEventsProps,
  type EventSourceService,
} from "./ConsumeEvents.ts";
import type { StripeEventClass, StripeEventInstance } from "./Events.ts";
import { WebhookEndpoint } from "./WebhookEndpoint.ts";

/** A host that accepts environment bindings, such as a Cloudflare Worker. */
export interface EnvBindingHost {
  readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
}

/**
 * Attach a webhook signing secret to a host's environment, under the key
 * {@link consumeEvents} reads for `path`.
 *
 * {@link consumeEvents} binds the secret itself for the endpoint it
 * provisions. Declare a {@link WebhookEndpoint} manually only when you need
 * a URL you already own; then bind the minted secret yourself.
 */
export const bindWebhookSecret = (
  host: EnvBindingHost,
  secret: WebhookEndpoint["secret"],
  path?: string,
): Effect.Effect<void> =>
  host.bind(`stripe-webhook:${webhookPath(path)}`, {
    env: {
      [webhookSecretEnvName(path)]: secret,
    },
  });

/**
 * {@link consumeEvents} on any {@link WebhookHost}.
 *
 * Deploy-time: provisions a {@link WebhookEndpoint} pointing at the host (at
 * the subscribed path) and binds its minted signing secret so deliveries can
 * be verified. Under `alchemy dev` the host is not publicly
 * reachable, so no endpoint is provisioned. Runtime: claims requests on that
 * path, verifies `Stripe-Signature`, and runs the handler once per event.
 *
 * Every Cloudflare Worker is a {@link WebhookHost}, so this is the only layer
 * to provide.
 *
 * @layer
 * @product Webhook
 * @provides Stripe.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps,
      process: (event: StripeEventInstance) => Effect.Effect<void, never, never>,
    ) {
      // The signing secret is bound through the host's RuntimeContext, which
      // every host provides its init, like `GitHub.RepositoryEventSourceLive`.
      const runtime = yield* RuntimeContext;
      const path = webhookPath(props.path);
      const secretKey = webhookSecretEnvName(path);
      const byType = new Map(props.events.map((event) => [event.type, event] as const));

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Stripe only delivers to public URLs, and under `alchemy dev` the
            // host is on localhost: skip the endpoint rather than fail the
            // whole stack. Deliveries then answer 500 (no signing secret).
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Stripe.consumeEvents: no webhook endpoint for ${path} under alchemy dev; Stripe only delivers to public URLs, so deploy to receive events.`,
              );
              return;
            }
            const endpoint = yield* WebhookEndpoint(id, {
              url: Output.interpolate`${host.url}${path}`,
              enabledEvents: [...props.events],
            });
            // A binding, not a prop: the endpoint depends on the host's URL.
            yield* bindWebhookSecret(host, endpoint.secret, path);
          }),
        );
      }

      const secret = runtime.get<unknown>(secretKey);
      yield* host.route(path, (request) => handleDelivery(request, secret, byType, process));
    }) as EventSourceService;
  }),
);

const asWebhookSecret = (raw: unknown): Redacted.Redacted<string> | undefined => {
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
  request: Request,
  secret: Effect.Effect<unknown>,
  byType: Map<string, StripeEventClass>,
  process: (event: StripeEventInstance) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const payload = yield* Effect.promise(() => request.text());
    const signature = request.headers.get("stripe-signature") ?? "";
    const resolved = asWebhookSecret(yield* secret);
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
        () => Effect.undefined,
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
      typeof parsed.data === "object" && parsed.data !== null && "object" in parsed.data
        ? (parsed.data as { object: unknown }).object
        : parsed.data;
    yield* process(new Ctor(data as never)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });
