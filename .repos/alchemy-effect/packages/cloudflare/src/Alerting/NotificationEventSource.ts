import { sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { CustomAlert } from "./CustomAlert.ts";
import type { AlertType, NotificationPolicy } from "./NotificationPolicy.ts";

/**
 * Whether a notification opens or closes an incident. Alert types without
 * incidents leave it unset.
 */
export type NotificationAlertEvent =
  | "ALERT_STATE_EVENT_START"
  | "ALERT_STATE_EVENT_END"
  // Keep the union open so new Cloudflare states aren't blocked by stale types.
  | (string & {});

/**
 * One notification Cloudflare dispatched for a policy: the generic webhook
 * envelope, with the alert-specific payload in `data`.
 *
 * @see {@link https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/ | Webhook payload schema}
 */
export interface Notification<Data = Record<string, unknown>> {
  /** Name of the webhook destination that received the notification. */
  readonly name: string;
  /** Human-readable summary of the alert. */
  readonly text: string;
  /** Alert-specific payload. Its shape depends on `alertType`. */
  readonly data: Data;
  /** When Cloudflare generated the notification, in Unix seconds (UTC). */
  readonly ts: number;
  /** Account the alert fired in. Not sent by every alert type. */
  readonly accountId: string | undefined;
  /** Id of the policy that fired. Not sent by every alert type. */
  readonly policyId: string | undefined;
  /** Name of the policy that fired. */
  readonly policyName: string | undefined;
  /** The alert type that fired, e.g. `workers_observability_real_time_issue`. */
  readonly alertType: AlertType | undefined;
  /** Ties together the notifications of one incident. */
  readonly alertCorrelationId: string | undefined;
  /** Whether this notification opens or closes an incident. */
  readonly alertEvent: NotificationAlertEvent | undefined;
}

/** A policy whose notifications a runtime can consume. */
export type NotifyingPolicy = NotificationPolicy | CustomAlert;

export interface ConsumeNotificationsProps {
  /**
   * Secret Cloudflare sends in the `cf-webhook-auth` header of every
   * notification. Requests without it are rejected. When omitted, a random
   * secret is generated at deploy and bound onto the host.
   */
  secret?: Redacted.Redacted<string>;
  /**
   * Path on the host that Cloudflare delivers to. Defaults to a deterministic
   * per-policy path, so deliveries don't collide with your application
   * routes.
   */
  path?: string;
}

/**
 * Run an Effect for every notification a policy fires.
 *
 * Call it in the Construction phase of any runtime that receives HTTP (a
 * `WebhookHost`, such as a Cloudflare Worker). Cloudflare then delivers the
 * policy's notifications to that runtime: the event source creates a webhook
 * destination at the runtime's URL and adds it to the policy, so the policy
 * needs no `mechanisms` of its own.
 *
 * **Example:** Open a GitHub issue for each new Worker issue
 * ```typescript
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
 *   alertType: "workers_observability_real_time_issue",
 * });
 *
 * // `text` is Cloudflare's report: a summary line, then details and links.
 * const createIssue = yield* GitHub.CreateIssue(yield* Repo);
 * yield* Cloudflare.Alerting.consumeNotifications(policy, (notification) =>
 *   createIssue({
 *     title: notification.text.split("\n")[0],
 *     body: notification.text,
 *   }),
 * );
 * ```
 *
 * **Example:** Page on a SQL custom alert, with your own secret
 * ```typescript
 * const errors = yield* ErrorSpike; // a Cloudflare.Alerting.CustomAlert
 *
 * yield* Cloudflare.Alerting.consumeNotifications(
 *   errors,
 *   { secret: yield* Config.Redacted("ALERT_WEBHOOK_SECRET") },
 *   (notification) =>
 *     notification.alertEvent === "ALERT_STATE_EVENT_END"
 *       ? pager.resolve(notification.alertCorrelationId)
 *       : pager.trigger(notification.alertCorrelationId, notification.text),
 * );
 * ```
 *
 * @binding
 * @product Alerting
 */
export function consumeNotifications<Req = never>(
  policy: NotifyingPolicy,
  process: (notification: Notification) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, NotificationEventSource>;
export function consumeNotifications<Req = never>(
  policy: NotifyingPolicy,
  props: ConsumeNotificationsProps,
  process: (notification: Notification) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, NotificationEventSource>;
export function consumeNotifications(
  policy: NotifyingPolicy,
  propsOrProcess:
    | ConsumeNotificationsProps
    | ((notification: Notification) => Effect.Effect<void, never, any>),
  maybeProcess?: (notification: Notification) => Effect.Effect<void, never, any>,
): Effect.Effect<void, never, NotificationEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function" ? [{}, propsOrProcess] : [propsOrProcess, maybeProcess!];
  return NotificationEventSource.use((source) => source(policy, props, process));
}

export type NotificationEventSourceService = <Req = never>(
  policy: NotifyingPolicy,
  props: ConsumeNotificationsProps,
  process: (notification: Notification) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class NotificationEventSource extends Context.Service<
  NotificationEventSource,
  NotificationEventSourceService
>()("Cloudflare.Alerting.NotificationEventSource") {}

/**
 * Delivery path of a policy's notifications. Shared by the deploy-time half
 * (the webhook URL) and the runtime half (the claimed route).
 */
export const notificationPath = (
  policy: Pick<NotifyingPolicy, "LogicalId">,
  props: Pick<ConsumeNotificationsProps, "path"> = {},
): string =>
  props.path ?? `/__alchemy/cloudflare/notifications/${encodeURIComponent(policy.LogicalId)}`;

/** Env var under which the host holds a policy's webhook secret. */
export const notificationSecretEnvName = (policy: Pick<NotifyingPolicy, "LogicalId">): string =>
  `ALCHEMY_CLOUDFLARE_NOTIFICATION_SECRET_${sanitizeKey(policy.LogicalId)}`;
