import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.RealtimeKit.Webhook" as const;
type TypeId = typeof TypeId;

/**
 * Event that can trigger a RealtimeKit webhook.
 */
export type WebhookEvent =
  | "meeting.started"
  | "meeting.ended"
  | "meeting.participantJoined"
  | "meeting.participantLeft"
  | "meeting.chatSynced"
  | "recording.statusUpdate"
  | "livestreaming.statusUpdate"
  | "meeting.transcript"
  | "meeting.summary";

export type WebhookProps = {
  /**
   * The RealtimeKit app the webhook belongs to. Changing the app triggers a
   * replacement.
   */
  appId: string;
  /**
   * Human readable webhook name. If omitted, a unique name is generated from
   * the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * URL this webhook will send events to. Often a deployed Worker URL.
   */
  url: string;
  /**
   * Events that trigger this webhook.
   */
  events: WebhookEvent[];
  /**
   * Whether the webhook is active.
   * @default true
   */
  enabled?: boolean;
};

export type WebhookAttributes = {
  /**
   * Server-generated webhook identifier. Stable across updates.
   */
  webhookId: string;
  /**
   * The Cloudflare account the webhook belongs to.
   */
  accountId: string;
  /**
   * The RealtimeKit app the webhook belongs to.
   */
  appId: string;
  /**
   * Human readable webhook name.
   */
  name: string;
  /**
   * URL the webhook sends events to.
   */
  url: string;
  /**
   * Events that trigger this webhook.
   */
  events: WebhookEvent[];
  /**
   * Whether the webhook is active.
   */
  enabled: boolean;
  /**
   * When the webhook was created.
   */
  createdAt: string;
  /**
   * When the webhook was last modified.
   */
  updatedAt: string;
};

export type Webhook = Resource<
  TypeId,
  WebhookProps,
  WebhookAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare RealtimeKit webhook — receives meeting, recording,
 * livestream, transcript, and summary events for a RealtimeKit app.
 *
 * Name, URL, events, and enablement are all mutable in place; only moving
 * the webhook to a different app forces a replacement.
 * @resource
 * @product Realtime Kit
 * @category Media
 * @section Creating a Webhook
 * @example Meeting lifecycle events
 * ```typescript
 * const app = yield* Cloudflare.RealtimeKit.App("Meetings", {});
 *
 * const webhook = yield* Cloudflare.RealtimeKit.Webhook("Lifecycle", {
 *   appId: app.appId,
 *   url: "https://example.com/webhook",
 *   events: ["meeting.started", "meeting.ended"],
 * });
 * ```
 *
 * @example Recording events to a Worker
 * ```typescript
 * const webhook = yield* Cloudflare.RealtimeKit.Webhook("Recordings", {
 *   appId: app.appId,
 *   url: worker.url,
 *   events: ["recording.statusUpdate"],
 * });
 * ```
 *
 * @section Updating a Webhook
 * @example Pause delivery without deleting
 * ```typescript
 * const webhook = yield* Cloudflare.RealtimeKit.Webhook("Lifecycle", {
 *   appId: app.appId,
 *   url: "https://example.com/webhook",
 *   events: ["meeting.started", "meeting.ended"],
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/realtime/realtimekit/
 */
export const Webhook = Resource<Webhook>(TypeId);

/**
 * Returns true if the given value is a Webhook resource.
 */
export const isWebhook = (value: unknown): value is Webhook =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookId", "accountId", "appId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The app is a path parameter — a webhook cannot move between apps in
      // place. By diff time both sides are resolved strings.
      const oldAppId = output?.appId ?? olds?.appId;
      if (
        typeof oldAppId === "string" &&
        typeof news.appId === "string" &&
        oldAppId !== news.appId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const appId = output?.appId ?? (olds?.appId as string | undefined);
      if (appId === undefined) return undefined;

      if (output?.webhookId) {
        const observed = yield* getWebhook(acct, appId, output.webhookId);
        return observed ? toAttributes(observed, acct, appId) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createWebhookName(id, olds?.name);
      const match = yield* findByName(acct, appId, name);
      return match ? toAttributes(match, acct, appId) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const appId = news.appId as string;
      const name = yield* createWebhookName(id, news.name);
      const desired = {
        name,
        url: news.url as string,
        events: [...news.events],
        enabled: news.enabled ?? true,
      };

      // Observe — the webhookId cached on `output` is a hint, not a
      // guarantee: a missing webhook falls through and we recreate.
      const observed = output?.webhookId
        ? yield* getWebhook(
            output.accountId ?? accountId,
            appId,
            output.webhookId,
          )
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the full
        // desired body. The API rejects a duplicate name in the same app
        // with a 409 (`RealtimeKitWebhookExists`); this happens when a prior
        // run leaked a same-named webhook (lost state) or when a retried
        // create races a 500 that actually persisted. Adopt the existing
        // webhook by name and converge it to the desired body instead of
        // leaking / failing.
        const created = yield* realtimeKit
          .createWebhookWebhook({ accountId, appId, ...desired })
          .pipe(
            Effect.catchTag("RealtimeKitWebhookExists", () =>
              Effect.succeed(undefined),
            ),
          );
        if (created) {
          return toAttributes(created.data, accountId, appId);
        }
        const existing = yield* findByName(accountId, appId, name);
        if (!existing) {
          // Conflict reported but the webhook isn't visible yet — let the
          // engine retry the reconcile rather than silently succeeding.
          return yield* realtimeKit
            .createWebhookWebhook({ accountId, appId, ...desired })
            .pipe(
              Effect.map((res) => toAttributes(res.data, accountId, appId)),
            );
        }
        yield* realtimeKit.replaceWebhookWebhook({
          accountId,
          appId,
          webhookId: existing.id,
          ...desired,
        });
        const adopted = yield* realtimeKit.getWebhookByIdWebhook({
          accountId,
          appId,
          webhookId: existing.id,
        });
        return toAttributes(adopted.data, accountId, appId);
      }

      // Sync — diff observed cloud state against desired; the update API is
      // a PUT that takes the full body, so send everything, but skip the
      // call entirely on a no-op.
      const observedShape = {
        name: observed.name,
        url: observed.url,
        events: [...observed.events].sort(),
        enabled: observed.enabled,
      };
      const desiredShape = { ...desired, events: [...desired.events].sort() };
      if (JSON.stringify(observedShape) === JSON.stringify(desiredShape)) {
        return toAttributes(observed, accountId, appId);
      }
      yield* realtimeKit.replaceWebhookWebhook({
        accountId,
        appId,
        webhookId: observed.id,
        ...desired,
      });
      // The PUT response is a partial echo — re-read for fresh attributes.
      const fresh = yield* realtimeKit.getWebhookByIdWebhook({
        accountId,
        appId,
        webhookId: observed.id,
      });
      return toAttributes(fresh.data, accountId, appId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* realtimeKit
        .deleteWebhookWebhook({
          accountId: output.accountId,
          appId: output.appId,
          webhookId: output.webhookId,
        })
        .pipe(Effect.catchTag("RealtimeKitWebhookNotFound", () => Effect.void));
    }),
    // Webhooks are keyed by {accountId, appId, webhookId} with no account-wide
    // enumeration API, so fan out: enumerate every RealtimeKit app in the
    // account, then list each app's webhooks and flatten. The apps endpoint
    // 403s (`Forbidden`) when RealtimeKit isn't enabled on the account — an
    // unentitled account simply has no webhooks. Neither endpoint paginates.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const appIds = yield* realtimeKit.getApp({ accountId }).pipe(
        Effect.map((apps) =>
          (apps.data ?? [])
            .map((app) => app?.id)
            .filter((id): id is string => typeof id === "string"),
        ),
        Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
      );
      const perApp = yield* Effect.forEach(
        appIds,
        (appId) =>
          realtimeKit.getWebhooksWebhook({ accountId, appId }).pipe(
            Effect.map((res) =>
              res.data.map((webhook) =>
                toAttributes(webhook, accountId, appId),
              ),
            ),
            // An app with no webhooks 404s (`RealtimeKitWebhookNotFound`).
            Effect.catchTag("RealtimeKitWebhookNotFound", () =>
              Effect.succeed([] as WebhookAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return perApp.flat();
    }),
  });

type ObservedWebhook = realtimeKit.GetWebhookByIdWebhookResponse["data"];

/**
 * Read a webhook by id, mapping "gone" (`RealtimeKitWebhookNotFound`,
 * HTTP 404) to `undefined`.
 */
const getWebhook = (accountId: string, appId: string, webhookId: string) =>
  realtimeKit.getWebhookByIdWebhook({ accountId, appId, webhookId }).pipe(
    Effect.map((res) => res.data),
    Effect.catchTag("RealtimeKitWebhookNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a webhook by exact name. The list endpoint 404s
 * (`RealtimeKitWebhookNotFound`) when the app has no webhooks at all —
 * treat that as an empty list. If several webhooks carry the same name,
 * pick the oldest for determinism.
 */
const findByName = (accountId: string, appId: string, name: string) =>
  realtimeKit.getWebhooksWebhook({ accountId, appId }).pipe(
    Effect.map((list) =>
      [...list.data]
        .filter((w) => w.name === name)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(0),
    ),
    Effect.catchTag("RealtimeKitWebhookNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

const createWebhookName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  webhook: ObservedWebhook,
  accountId: string,
  appId: string,
): WebhookAttributes => ({
  webhookId: webhook.id,
  accountId,
  appId,
  name: webhook.name,
  url: webhook.url,
  // Distilled widens generated string enums to open unions (`string & {}`).
  events: [...webhook.events] as WebhookEvent[],
  enabled: webhook.enabled,
  createdAt: webhook.createdAt,
  updatedAt: webhook.updatedAt,
});
