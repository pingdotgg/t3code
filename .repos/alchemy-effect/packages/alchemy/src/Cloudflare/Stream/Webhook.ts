import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Stream.Webhook" as const;
type TypeId = typeof TypeId;

export type WebhookProps = {
  /**
   * The URL where Stream webhook notifications (e.g. video ready,
   * live input connected/disconnected) are sent. Mutable — updated in
   * place via Cloudflare's PUT upsert.
   */
  notificationUrl: string;
};

export type WebhookAttributes = {
  /**
   * The Cloudflare account the webhook belongs to.
   */
  accountId: string;
  /**
   * The URL where webhook notifications are sent.
   */
  notificationUrl: string;
  /**
   * The date and time the webhook was last modified.
   */
  modified: string | undefined;
  /**
   * The HMAC secret used to verify webhook request signatures
   * (`Webhook-Signature` header).
   */
  secret: Redacted.Redacted<string>;
};

export type Webhook = Resource<
  TypeId,
  WebhookProps,
  WebhookAttributes,
  never,
  Providers
>;

/**
 * The Cloudflare Stream webhook — an **account-level singleton** that
 * receives notifications when videos finish processing or live inputs
 * connect/disconnect.
 *
 * Each account has at most one Stream webhook, so creating this
 * resource takes over the account's webhook slot; an existing webhook
 * configured outside Alchemy is only adopted when `--adopt` is set.
 * Destroying the resource deletes the webhook configuration.
 *
 * Requires the Stream subscription to be enabled on the account.
 * @resource
 * @product Stream
 * @category Media
 * @section Configuring the webhook
 * @example Receive Stream notifications
 * ```typescript
 * const webhook = yield* Cloudflare.Stream.Webhook("Notifications", {
 *   notificationUrl: "https://example.com/hooks/stream",
 * });
 *
 * // Verify the Webhook-Signature header with the HMAC secret:
 * const secret = webhook.secret; // Redacted<string>
 * ```
 *
 * @see https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/
 */
export const Webhook = Resource<Webhook>(TypeId);

/**
 * Returns true if the given value is a Webhook resource.
 */
export const isWebhook = (value: unknown): value is Webhook =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["accountId"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The webhook is a singleton per account — moving accounts is a
      // replacement.
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = yield* getWebhook(acct);
      if (observed === undefined) return undefined;
      const attrs = toAttributes(observed, acct);
      // The webhook is an account singleton with no ownership markers.
      // On a cold read (no prior output) an existing webhook was
      // configured outside Alchemy — brand it `Unowned` so the engine
      // refuses to take over unless `--adopt` is set.
      if (output === undefined) return Unowned(attrs);
      return attrs;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-level singleton: the account has at most one Stream
      // webhook, so enumerate by reading that single slot — return a
      // one-element array when configured, [] when unset. Exactly
      // mirrors `read`.
      const observed = yield* getWebhook(accountId);
      if (observed === undefined) return [];
      return [toAttributes(observed, accountId)];
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Observe — read the live webhook config (`WebhookNotFound` means
      // the account has no webhook yet).
      const observed = yield* getWebhook(acct);

      // Sync — PUT is a true upsert, so create and update are the same
      // call. Skip the API entirely when the observed URL already
      // matches the desired one.
      if (
        observed !== undefined &&
        observed.notificationUrl === news.notificationUrl
      ) {
        return toAttributes(observed, acct);
      }
      const updated = yield* stream.putWebhook({
        accountId: acct,
        notificationUrl: news.notificationUrl,
      });
      return toAttributes(updated, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DELETE on an already-absent webhook returns success, so the
      // operation is naturally idempotent; tolerate `WebhookNotFound`
      // anyway.
      yield* stream
        .deleteWebhook({ accountId: output.accountId })
        .pipe(Effect.catchTag("WebhookNotFound", () => Effect.void));
    }),
  });

/**
 * Read the account's webhook, mapping "not configured"
 * (`WebhookNotFound`, Cloudflare error code 10003) to `undefined`.
 */
const getWebhook = (accountId: string) =>
  stream
    .getWebhook({ accountId })
    .pipe(Effect.catchTag("WebhookNotFound", () => Effect.succeed(undefined)));

const toAttributes = (
  webhook: stream.GetWebhookResponse | stream.PutWebhookResponse,
  accountId: string,
): WebhookAttributes => ({
  accountId,
  notificationUrl: webhook.notificationUrl ?? "",
  modified: webhook.modified ?? undefined,
  secret: Redacted.make(webhook.secret ?? ""),
});
