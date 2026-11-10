import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  createPolicyName,
  findPolicyByName,
  narrowPolicy,
  type ObservedPolicy,
  boundMechanisms,
  type NotificationPolicyBinding,
  observePolicy,
  type PolicyBody,
  policyEqualsObserved,
} from "./internal.ts";

export class NotificationPolicyUnexpectedResponse extends Data.TaggedError(
  "NotificationPolicyUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type { NotificationPolicyBinding } from "./internal.ts";

const TypeId = "Cloudflare.Alerting.NotificationPolicy" as const;
type TypeId = typeof TypeId;

/**
 * The event that triggers a notification dispatch. The full catalog (and
 * which types your plan can use) is returned by the available-alerts
 * endpoint. The union is kept open so new Cloudflare alert types aren't
 * blocked by stale types.
 */
export type AlertType = alerting.CreatePolicyRequest["alertType"];

/**
 * Optional filters restricting which events trigger the policy. Which keys
 * are valid (or required — Cloudflare returns `FiltersRequired`) depends on
 * the alert type.
 */
export type NotificationPolicyFilters = alerting.CreatePolicyRequest["filters"];

/**
 * Destinations notified when the policy fires. At least one mechanism is
 * required (Cloudflare returns `MechanismRequired` otherwise). Email ids
 * are email addresses; webhook/pagerduty ids reference destination UUIDs.
 */
export interface NotificationPolicyMechanisms {
  /** Email destinations — `id` is the recipient email address. */
  email?: ReadonlyArray<{ id: string }>;
  /** Webhook destinations — `id` references a {@link NotificationWebhook}. */
  webhooks?: ReadonlyArray<{ id: string }>;
  /** PagerDuty destinations — `id` references a connected PagerDuty service. */
  pagerduty?: ReadonlyArray<{ id: string }>;
}

export interface NotificationPolicyProps {
  /**
   * Name of the policy. If omitted, a unique name is generated.
   * Mutable — renames are applied in place.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * The event that triggers a notification dispatch (e.g.
   * `universal_ssl_event_type`, `billing_usage_alert`). Changing the alert
   * type triggers a replacement: the valid filter set depends on the alert
   * type, so a policy alerting on a different event is a different policy.
   */
  alertType: AlertType;
  /**
   * Whether the policy is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Optional human-readable description of the policy.
   */
  description?: string;
  /**
   * How often to re-alert from the same incident (e.g. `"30m"`). Not
   * supported by all alert types.
   */
  alertInterval?: string;
  /**
   * Destinations notified when the policy fires. At least one destination is
   * required, either declared here or bound by a runtime that consumes the
   * policy's notifications (`Cloudflare.Alerting.consumeNotifications`).
   */
  mechanisms?: NotificationPolicyMechanisms;
  /**
   * Optional filters restricting which events trigger the policy. Some
   * alert types require specific filters (`FiltersRequired`).
   */
  filters?: NotificationPolicyFilters;
}

export interface NotificationPolicyAttributes {
  /** Cloudflare-assigned notification policy UUID. */
  policyId: string;
  /** Account that owns this policy. */
  accountId: string;
  /** Name of the policy. */
  name: string;
  /** The alert type the policy fires on. */
  alertType: AlertType;
  /** Whether the policy is enabled. */
  enabled: boolean;
  /** ISO8601 creation timestamp. */
  created: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modified: string | undefined;
}

export type NotificationPolicy = Resource<
  TypeId,
  NotificationPolicyProps,
  NotificationPolicyAttributes,
  NotificationPolicyBinding,
  Providers
>;

/**
 * A Cloudflare Notifications policy.
 *
 * A notification policy connects an alert type (the event Cloudflare
 * watches for) to one or more destinations — email addresses, webhook
 * destinations, or PagerDuty services — optionally narrowed by filters.
 * ### Creating a policy
 * **Example:** Email notifications for Universal SSL events
 * ```typescript
 * yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 * ```
 *
 * **Example:** Disabled policy with a description
 * ```typescript
 * yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 *   enabled: false,
 *   description: "Paused during migration",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 * ```
 *
 * ### Webhook destinations
 * **Example:** Dispatch to a webhook destination
 * ```typescript
 * const webhook = yield* Cloudflare.Alerting.NotificationWebhook("AlertsHook", {
 *   url: "https://alerts.example.com/cf",
 * });
 *
 * yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 *   mechanisms: { webhooks: [{ id: webhook.webhookId }] },
 * });
 * ```
 *
 * ### Filters
 * **Example:** Health check alerts for specific zones
 * ```typescript
 * yield* Cloudflare.Alerting.NotificationPolicy("HealthAlerts", {
 *   alertType: "health_check_status_notification",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 *   filters: {
 *     healthCheckId: [healthCheckId],
 *     newHealth: ["Unhealthy"],
 *   },
 * });
 * ```
 *
 * ### Handling notifications in code
 * **Example:** Run an Effect for each notification
 * `consumeNotifications` adds a webhook destination at the consuming
 * runtime, so the policy needs no `mechanisms`.
 * ```typescript
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("SslAlerts", {
 *   alertType: "universal_ssl_event_type",
 * });
 *
 * // in a Worker's Construction phase, with NotificationEventSourceLive provided
 * yield* Cloudflare.Alerting.consumeNotifications(policy, (notification) =>
 *   Effect.log(notification.text),
 * );
 * ```
 *
 * ### SQL custom alerts <!-- api-prose -->
 * Alerts on a SQL query (Cloudflare's `custom_analytics` alert type) have
 * their own resource with typed triggers: `Cloudflare.Alerting.CustomAlert`.
 *
 * ### Workers Issues notifications
 * **Example:** Notify on new Worker issues
 * ```typescript
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
 *   alertType: "workers_observability_real_time_issue",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 *
 * yield* Cloudflare.Workers.IssueAutomation("IssueAlerts", {
 *   policyId: policy.policyId,
 *   afterOccurrences: 5,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/notifications/
 *
 * @resource
 * @product Alerting
 * @category Observability & Analytics
 */
export const NotificationPolicy = Resource<NotificationPolicy>(TypeId);

/**
 * Returns true if the given value is a NotificationPolicy resource.
 */
export const isNotificationPolicy = (value: unknown): value is NotificationPolicy =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const NotificationPolicyProvider = () =>
  Provider.succeed(NotificationPolicy, {
    stables: ["policyId", "accountId", "alertType"],

    // Account-scoped collection: exhaustively paginate the account's
    // notification policies and hydrate each into the `read` attribute shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* alerting.listPolicies.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map(narrowPolicy)
              .filter((p): p is ObservedPolicy => p !== undefined)
              .map((p) => toPolicyAttributes(p, accountId)),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The valid filter/mechanism shape depends on the alert type — a
      // policy alerting on a different event is a different policy.
      // `alertType` is a plain string prop, statically knowable here.
      const o = olds as NotificationPolicyProps;
      const n = news as NotificationPolicyProps;
      const oldAlertType = output?.alertType ?? o.alertType;
      if (oldAlertType !== undefined && oldAlertType !== n.alertType) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted policy id.
      if (output?.policyId) {
        const observed = yield* observePolicy(acct, output.policyId);
        if (observed) return toPolicyAttributes(observed, acct);
        return undefined;
      }

      // Cold read: no persisted id (state-persistence failure) — find the
      // deterministic physical name in the account's policy list.
      const name = yield* createPolicyName(id, olds?.name);
      const match = yield* findPolicyByName(acct, name);
      if (match) return toPolicyAttributes(match, acct);
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createPolicyName(id, news.name);
      const desired = buildPolicyBody(name, news, bindings);

      // 1. Observe — by cached id first, then by deterministic name.
      let observed: ObservedPolicy | undefined;
      if (output?.policyId) {
        observed = yield* observePolicy(accountId, output.policyId);
      }
      if (!observed) {
        observed = yield* findPolicyByName(accountId, name);
      }

      // 2. Ensure — create when missing. `createPolicy` only returns the
      //    new id; re-read for the full attribute set.
      if (!observed) {
        const created = yield* alerting.createPolicy({
          accountId,
          ...desired,
        });
        if (!created.id) {
          return yield* new NotificationPolicyUnexpectedResponse({
            message: "Cloudflare did not return an id for the created notification policy",
          });
        }
        const fresh = yield* observePolicy(accountId, created.id);
        return toPolicyAttributes(fresh ?? { id: created.id }, accountId);
      }

      // 3. Sync — PUT the full desired body when any mutable aspect
      //    drifts from the observed cloud state.
      if (!policyEqualsObserved(desired, observed)) {
        yield* alerting.updatePolicy({
          accountId,
          policyId: observed.id,
          ...desired,
        });
        const fresh = yield* observePolicy(accountId, observed.id);
        return toPolicyAttributes(fresh ?? observed, accountId);
      }

      // 4. Return.
      return toPolicyAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* alerting
        .deletePolicy({
          accountId: output.accountId,
          policyId: output.policyId,
        })
        .pipe(Effect.catchTag("PolicyNotFound", () => Effect.void));
    }),
  });

const toPolicyAttributes = (
  observed: ObservedPolicy,
  accountId: string,
): NotificationPolicyAttributes => ({
  policyId: observed.id,
  accountId,
  name: observed.name ?? "",
  alertType: (observed.alertType ?? "universal_ssl_event_type") as AlertType,
  enabled: observed.enabled ?? true,
  created: observed.created,
  modified: observed.modified,
});

const buildPolicyBody = (
  name: string,
  news: NotificationPolicyProps,
  bindings: ReadonlyArray<{ data: NotificationPolicyBinding }>,
): PolicyBody => ({
  name,
  alertType: news.alertType,
  enabled: news.enabled ?? true,
  description: news.description,
  alertInterval: news.alertInterval,
  // `Input<string>` ids are resolved to concrete strings by the engine
  // before reconcile runs; bound webhooks extend the declared ones.
  mechanisms: boundMechanisms(news.mechanisms, bindings),
  filters: news.filters,
});

/**
 * Compare the desired policy body against observed cloud state.
 * `mechanisms`/`filters` are compared structurally with `null`/`undefined`
 * dropped and object keys sorted, since Cloudflare echoes optional fields
 * as `null`.
 */
