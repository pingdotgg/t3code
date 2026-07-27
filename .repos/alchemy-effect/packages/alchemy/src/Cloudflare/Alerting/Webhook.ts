import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Alerting.Webhook" as const;
type TypeId = typeof TypeId;

/**
 * Webhook destination endpoint type, inferred by Cloudflare from the URL.
 */
export type NotificationWebhookType =
  | "datadog"
  | "discord"
  | "feishu"
  | "gchat"
  | "generic"
  | "opsgenie"
  | "slack"
  | "splunk"
  // Keep the union open so new Cloudflare destination types aren't blocked
  // by stale types.
  | (string & {});

export interface NotificationWebhookProps {
  /**
   * Name of the webhook destination. Included in the request body when a
   * notification is dispatched. If omitted, a unique name is generated.
   * Mutable — renames are applied in place.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * The POST endpoint Cloudflare calls when dispatching a notification.
   * Cloudflare sends a test request on create/update; the endpoint must
   * respond with a 2xx or the operation fails with `WebhookTestFailed`.
   * Mutable — updated in place.
   */
  url: string;
  /**
   * Optional secret sent in the `cf-webhook-auth` header on every
   * notification dispatch (for generic webhooks). Write-only: Cloudflare
   * never returns it, so drift cannot be observed — the secret is re-sent
   * whenever the prop value changes.
   */
  secret?: Redacted.Redacted<string>;
}

export interface NotificationWebhookAttributes {
  /** Cloudflare-assigned webhook destination UUID. */
  webhookId: string;
  /** Account that owns this webhook destination. */
  accountId: string;
  /** Name of the webhook destination. */
  name: string;
  /** The POST endpoint called when dispatching a notification. */
  url: string;
  /** Endpoint type inferred by Cloudflare from the URL (e.g. `generic`, `slack`). */
  type: NotificationWebhookType | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
}

export type NotificationWebhook = Resource<
  TypeId,
  NotificationWebhookProps,
  NotificationWebhookAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Notifications webhook destination.
 *
 * Webhook destinations receive alert notifications dispatched by
 * {@link NotificationPolicy | notification policies}. Cloudflare sends a
 * test POST to the URL when the webhook is created or updated, so the
 * endpoint must be live and respond with a 2xx.
 * @resource
 * @product Alerting
 * @category Observability & Analytics
 * @section Creating a Webhook destination
 * @example Generic webhook with a generated name
 * ```typescript
 * const webhook = yield* Cloudflare.Alerting.NotificationWebhook("AlertsHook", {
 *   url: "https://alerts.example.com/cf",
 * });
 * ```
 *
 * @example Webhook with an auth secret
 * The secret is sent in the `cf-webhook-auth` header on every dispatch.
 * ```typescript
 * const webhook = yield* Cloudflare.Alerting.NotificationWebhook("AlertsHook", {
 *   name: "production-alerts",
 *   url: "https://alerts.example.com/cf",
 *   secret: alchemy.secret.env.WEBHOOK_SECRET,
 * });
 * ```
 *
 * @section Using with a Notification policy
 * @example Dispatch policy notifications to the webhook
 * ```typescript
 * yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 *   mechanisms: { webhooks: [{ id: webhook.webhookId }] },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/notifications/get-started/configure-webhooks/
 */
export const NotificationWebhook = Resource<NotificationWebhook>(TypeId);

/**
 * Returns true if the given value is a NotificationWebhook resource.
 */
export const isNotificationWebhook = (
  value: unknown,
): value is NotificationWebhook =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const NotificationWebhookProvider = () =>
  Provider.succeed(NotificationWebhook, {
    stables: ["webhookId", "accountId"],

    // Account collection (pattern b): enumerate every webhook destination in
    // the account and hydrate each into the same Attributes shape `read`
    // returns. The secret is write-only (never returned by Cloudflare), so it
    // is absent from Attributes and there is nothing extra to fetch per item.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* alerting.listDestinationWebhooks.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map(narrowWebhook)
              .filter((w): w is ObservedWebhook => w !== undefined)
              .map((w) => toWebhookAttributes(w, accountId)),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted webhook id.
      if (output?.webhookId) {
        const observed = yield* observeWebhook(acct, output.webhookId);
        if (observed) return toWebhookAttributes(observed, acct);
      }

      // Cold read: no persisted id (state-persistence failure) — find the
      // deterministic physical name in the account's webhook list.
      const name = yield* createWebhookName(id, olds?.name);
      const match = yield* findWebhookByName(acct, name);
      if (match) return toWebhookAttributes(match, acct);
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createWebhookName(id, news.name);
      // Inputs are resolved to concrete values by the engine before
      // reconcile runs.
      const url = news.url as string;
      const secret =
        news.secret === undefined ? undefined : Redacted.value(news.secret);

      // 1. Observe — by cached id first, then by deterministic name.
      let observed: ObservedWebhook | undefined;
      if (output?.webhookId) {
        observed = yield* observeWebhook(accountId, output.webhookId);
      }
      if (!observed) {
        observed = yield* findWebhookByName(accountId, name);
      }

      // 2. Ensure — create when missing. Cloudflare fires a test POST at
      //    the URL from an arbitrary PoP; when the destination is a
      //    just-deployed Worker that PoP may not have the fresh
      //    workers.dev subdomain yet and the test POST 404s even though
      //    the URL serves elsewhere. A short bounded retry rides out edge
      //    propagation; a genuinely broken endpoint still fails after the
      //    budget is exhausted.
      if (!observed) {
        const created = yield* alerting
          .createDestinationWebhook({
            accountId,
            name,
            url,
            secret,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "WebhookTestFailed",
              schedule: Schedule.max([
                Schedule.exponential("1 second"),
                Schedule.recurs(5),
              ]),
            }),
          );
        if (!created.id) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare did not return an id for the created webhook destination",
            ),
          );
        }
        const fresh = yield* observeWebhook(accountId, created.id);
        return toWebhookAttributes(fresh ?? { id: created.id }, accountId);
      }

      // 3. Sync — PUT the full desired body when any observable field
      //    drifts, or when the (write-only, unobservable) secret prop
      //    changed between olds and news.
      const oldSecret =
        olds?.secret === undefined ? undefined : Redacted.value(olds.secret);
      const secretChanged = secret !== oldSecret;
      if (observed.name !== name || observed.url !== url || secretChanged) {
        // The update PUT fires the same test POST as create — ride out edge
        // propagation of a just-deployed destination URL the same way.
        yield* alerting
          .updateDestinationWebhook({
            accountId,
            webhookId: observed.id,
            name,
            url,
            secret,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "WebhookTestFailed",
              schedule: Schedule.max([
                Schedule.exponential("1 second"),
                Schedule.recurs(5),
              ]),
            }),
          );
        const fresh = yield* observeWebhook(accountId, observed.id);
        return toWebhookAttributes(fresh ?? observed, accountId);
      }

      // 4. Return.
      return toWebhookAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare answers `deleteDestinationWebhook` for a webhook that no
      // longer exists with a generic `InternalServerError` (code 15000)
      // rather than a not-found error. Since that envelope is
      // indistinguishable from a genuine server fault, catch the typed tag
      // and verify the webhook is actually gone: `WebhookNotFound` on the
      // follow-up read confirms idempotent success; anything still present
      // re-fails with the original error.
      yield* alerting
        .deleteDestinationWebhook({
          accountId: output.accountId,
          webhookId: output.webhookId,
        })
        .pipe(
          Effect.catchTag("InternalServerError", (e) =>
            observeWebhook(output.accountId, output.webhookId).pipe(
              Effect.flatMap((observed) =>
                observed === undefined ? Effect.void : Effect.fail(e),
              ),
            ),
          ),
        );
    }),
  });

interface ObservedWebhook {
  readonly id: string;
  readonly name?: string;
  readonly url?: string;
  readonly type?: NotificationWebhookType;
  readonly createdAt?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const narrowWebhook = (raw: {
  id?: string | null;
  name?: string | null;
  url?: string | null;
  type?: string | null;
  createdAt?: string | null;
}): ObservedWebhook | undefined =>
  raw.id == null
    ? undefined
    : {
        id: raw.id,
        name: undef(raw.name),
        url: undef(raw.url),
        type: undef(raw.type) as NotificationWebhookType | undefined,
        createdAt: undef(raw.createdAt),
      };

const observeWebhook = (accountId: string, webhookId: string) =>
  alerting.getDestinationWebhook({ accountId, webhookId }).pipe(
    Effect.map((w) => narrowWebhook({ ...w, id: w.id ?? webhookId })),
    Effect.catchTag("WebhookNotFound", () => Effect.succeed(undefined)),
  );

const findWebhookByName = (accountId: string, name: string) =>
  alerting.listDestinationWebhooks.items({ accountId }).pipe(
    Stream.filter((w) => w.name === name && w.id != null),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map((w) => (w === undefined ? undefined : narrowWebhook(w))),
  );

const toWebhookAttributes = (
  observed: ObservedWebhook,
  accountId: string,
): NotificationWebhookAttributes => ({
  webhookId: observed.id,
  accountId,
  name: observed.name ?? "",
  url: observed.url ?? "",
  type: observed.type,
  createdAt: observed.createdAt,
});

const createWebhookName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });
