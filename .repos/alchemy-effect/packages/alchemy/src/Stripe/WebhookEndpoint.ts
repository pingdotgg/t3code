import { unwrapRedactedDeep } from "@distilled.cloud/core/protocol-rest";
import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteWebhookEndpoint,
  GetWebhookEndpoints,
  GetWebhookEndpoint,
  CreateWebhookEndpoint,
  UpdateWebhookEndpoint,
  type WebhookEndpoint as StripeWebhookEndpoint,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { arrayEquals } from "../Util/equal.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export type WebhookEndpointStatus = "enabled" | "disabled";

/**
 * A Stripe event type string (`"customer.created"`) or an event class
 * (`Stripe.CustomerCreated`) whose static `type` is used.
 */
export type WebhookEnabledEvent = string | { readonly type: string };

const enabledEventTypes = (events: readonly WebhookEnabledEvent[]): string[] =>
  events.map((event) => (typeof event === "string" ? event : event.type));

export interface WebhookEndpointProps {
  /**
   * HTTPS URL Stripe POSTs event payloads to.
   */
  url: string;
  /**
   * Event types this endpoint receives. Pass Stripe event classes
   * (`Stripe.CustomerCreated`) or type strings (`"customer.created"`).
   * `["*"]` enables every event except those that require explicit
   * selection.
   */
  enabledEvents: WebhookEnabledEvent[];
  /**
   * Optional description of what the webhook is used for.
   */
  description?: string;
  /**
   * Stripe API version event payloads are rendered as. Create-only —
   * changing it replaces the endpoint. Defaults to the account version.
   */
  apiVersion?: string;
  /**
   * When true, receive events from connected accounts instead of this
   * account. Create-only — changing it replaces the endpoint.
   * @default false
   */
  connect?: boolean;
  /**
   * When true, the endpoint is disabled and does not receive events.
   * @default false
   */
  disabled?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type WebhookEndpoint = Resource<
  "Stripe.WebhookEndpoint",
  WebhookEndpointProps,
  {
    /** Stripe webhook endpoint id (`we_…`). */
    id: string;
    /** HTTPS URL Stripe POSTs event payloads to. */
    url: string;
    /** Event types this endpoint receives. */
    enabledEvents: string[];
    /** Optional description of what the webhook is used for. */
    description: string | undefined;
    /** Stripe API version event payloads are rendered as, if set. */
    apiVersion: string | undefined;
    /** Associated Connect application id, if this is a Connect endpoint. */
    application: string | undefined;
    /** Whether this endpoint receives events from connected accounts. */
    connect: boolean;
    /** Whether the endpoint is currently receiving events. */
    status: WebhookEndpointStatus;
    /**
     * Signing secret, returned only at creation and preserved in state.
     * Never log this value.
     */
    secret: Redacted.Redacted<string> | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the endpoint was created. */
    created: number;
    /** Whether the endpoint exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe webhook endpoint — the HTTPS destination Stripe POSTs
 * event payloads to. URL, enabled events, description, disabled, and
 * metadata update in place. The signing `secret` is returned only on
 * create and is stored as `Redacted`. Deleting the resource deletes
 * the endpoint.
 *
 * @see https://docs.stripe.com/api/webhook_endpoints
 *
 * ### Creating an endpoint
 * **Example:** Charge events
 * ```typescript
 * const webhook = yield* Stripe.WebhookEndpoint("Charges", {
 *   url: "https://example.com/alchemy-stripe-webhook",
 *   enabledEvents: ["charge.succeeded", "charge.failed"],
 * });
 * ```
 *
 * **Example:** Event classes, for a Worker URL you already have
 * ```typescript
 * const webhook = yield* Stripe.WebhookEndpoint("Events", {
 *   url: Output.interpolate`${api.url}/webhooks/stripe`,
 *   enabledEvents: [Stripe.CustomerCreated, Stripe.InvoicePaid],
 * });
 * yield* Stripe.bindWebhookSecret(api, webhook.secret);
 * ```
 *
 * On a Worker, prefer `consumeEvents` — it provisions this endpoint and
 * binds the secret for you.
 *
 * **Example:** Description, metadata, and all events
 * ```typescript
 * const webhook = yield* Stripe.WebhookEndpoint("AllEvents", {
 *   url: "https://example.com/alchemy-stripe-webhook",
 *   enabledEvents: ["*"],
 *   description: "Alchemy test webhook",
 *   metadata: { purpose: "billing" },
 * });
 * ```
 *
 * ### Disabling an endpoint
 * **Example:** Disable without deleting
 * ```typescript
 * const webhook = yield* Stripe.WebhookEndpoint("Charges", {
 *   url: "https://example.com/alchemy-stripe-webhook",
 *   enabledEvents: ["charge.succeeded"],
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 */
export const WebhookEndpoint = Resource<WebhookEndpoint>(
  "Stripe.WebhookEndpoint",
);

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const redactSecret = (
  secret: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => {
  if (secret === undefined) return undefined;
  if (typeof secret === "string") return Redacted.make(secret);
  // Distilled and alchemy can resolve different `effect` copies, so a
  // SDK-wrapped Redacted is not readable via alchemy's WeakMap. Unwrap
  // with distilled first, then wrap with ours so state encoding works.
  try {
    return Redacted.make(Redacted.value(secret));
  } catch {
    const unwrapped = unwrapRedactedDeep(secret);
    return typeof unwrapped === "string" ? Redacted.make(unwrapped) : undefined;
  }
};

const toAttrs = (
  endpoint: StripeWebhookEndpoint,
  previousSecret?: Redacted.Redacted<string>,
) => ({
  id: endpoint.id,
  url: endpoint.url,
  enabledEvents: endpoint.enabled_events,
  description: endpoint.description ?? undefined,
  apiVersion: endpoint.api_version ?? undefined,
  application: endpoint.application ?? undefined,
  connect: endpoint.application != null,
  status: (endpoint.status === "disabled"
    ? "disabled"
    : "enabled") as WebhookEndpointStatus,
  secret: redactSecret(endpoint.secret) ?? previousSecret,
  metadata: userMetadata(endpoint.metadata),
  created: endpoint.created,
  livemode: endpoint.livemode,
});

const isMissingWebhookEndpoint = isMissingStripeResource;

const getById = (webhookEndpoint: string) =>
  GetWebhookEndpoint({
    webhook_endpoint: webhookEndpoint,
  }).pipe(
    Effect.catchIf(isMissingWebhookEndpoint, () => Effect.succeed(undefined)),
  );

const listAllWebhookEndpoints = Effect.fn(function* () {
  const endpoints: StripeWebhookEndpoint[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetWebhookEndpoints({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    endpoints.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return endpoints;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const endpoints = yield* listAllWebhookEndpoints();
  const matches: StripeWebhookEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (yield* hasAlchemyMetadata(id, tagRecord(endpoint.metadata))) {
      matches.push(endpoint);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const shouldReplace = (
  news: WebhookEndpointProps,
  output: WebhookEndpoint["Attributes"] | undefined,
) => {
  if (output === undefined) return false;
  if (news.apiVersion !== undefined && news.apiVersion !== output.apiVersion) {
    return true;
  }
  if (news.connect !== undefined && news.connect !== output.connect) {
    return true;
  }
  return false;
};

export const WebhookEndpointProvider = () =>
  Provider.succeed(WebhookEndpoint, {
    stables: [
      "id",
      "secret",
      "apiVersion",
      "connect",
      "application",
      "created",
      "livemode",
    ],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, output?.secret);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const endpoints = yield* listAllWebhookEndpoints();
      return endpoints
        .filter((endpoint) => {
          const metadata = tagRecord(endpoint.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map((endpoint) => toAttrs(endpoint));
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredDescription = news.description ?? "";
      const desiredDisabled = news.disabled ?? false;
      const desiredUrl = news.url;
      const desiredEvents = enabledEventTypes(news.enabledEvents);
      const previousSecret = output?.secret;

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
      });

      if (current === undefined) {
        current = yield* CreateWebhookEndpoint({
          url: desiredUrl,
          enabled_events: desiredEvents,
          ...(desiredDescription.length > 0
            ? { description: desiredDescription }
            : {}),
          ...(news.apiVersion !== undefined
            ? { api_version: news.apiVersion }
            : {}),
          ...(news.connect !== undefined ? { connect: news.connect } : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-webhook-endpoint-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const urlChanged = current.url !== desiredUrl;
      const eventsChanged = !arrayEquals(current.enabled_events, desiredEvents);
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const observedDisabled = current.status === "disabled";
      const disabledChanged = observedDisabled !== desiredDisabled;

      if (
        !urlChanged &&
        !eventsChanged &&
        !descriptionChanged &&
        !disabledChanged &&
        !metadataChanged
      ) {
        return toAttrs(current, previousSecret);
      }

      const updated = yield* UpdateWebhookEndpoint({
        webhook_endpoint: current.id,
        ...(urlChanged ? { url: desiredUrl } : {}),
        ...(eventsChanged ? { enabled_events: desiredEvents } : {}),
        ...(descriptionChanged ? { description: desiredDescription } : {}),
        ...(disabledChanged ? { disabled: desiredDisabled } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated, previousSecret);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteWebhookEndpoint({
        webhook_endpoint: output.id,
      }).pipe(Effect.catchIf(isMissingWebhookEndpoint, () => Effect.void));
    }),
  });
