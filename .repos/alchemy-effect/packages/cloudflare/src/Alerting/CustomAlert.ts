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
  boundMechanisms,
  createPolicyName,
  findPolicyByName,
  narrowPolicy,
  type NotificationPolicyBinding,
  type ObservedPolicy,
  observePolicy,
  type PolicyBody,
  policyEqualsObserved,
} from "./internal.ts";
import type { NotificationPolicyMechanisms } from "./NotificationPolicy.ts";

export class CustomAlertUnexpectedResponse extends Data.TaggedError(
  "CustomAlertUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const TypeId = "Cloudflare.Alerting.CustomAlert" as const;
type TypeId = typeof TypeId;

/**
 * A time window in minutes or hours, at least one minute (e.g. `"5m"`,
 * `"1h"`).
 */
export type CustomAlertWindow = `${number}m` | `${number}h`;

/**
 * Fire when the query result crosses a fixed value.
 */
export interface CustomAlertThresholdTrigger {
  type: "threshold";
  /** How the query result is compared to `value`. */
  operator: "<" | ">" | "<=" | ">=" | "==" | "!=";
  /** The value the query result is compared to. */
  value: number;
  /** The time range the query covers on each evaluation. */
  window: CustomAlertWindow;
  /** Don't fire while the query result is below this value. */
  minimumThreshold?: number;
}

/**
 * Fire when the query result moves away from its recent baseline.
 */
export interface CustomAlertAnomalyTrigger {
  type: "anomaly";
  /** Fire on spikes, drops, or both. */
  direction: "spike" | "drop" | "both";
  /** How many standard deviations from the baseline count as an anomaly. */
  zScore: number;
  /** The time range the query covers on each evaluation. */
  window: CustomAlertWindow;
  /** The longer time range the baseline is computed over. */
  baselineWindow: CustomAlertWindow;
  /** Don't fire while the query result is below this value. */
  minimumThreshold?: number;
}

/**
 * Fire when the query result falls below a service level objective,
 * checked over a short and a long window.
 */
export interface CustomAlertSloTrigger {
  type: "slo";
  /** The objective the query result is held to (e.g. `99.9`). */
  target: number;
  /** The short window the objective is checked over. */
  shortWindow: CustomAlertWindow;
  /** The long window the objective is checked over. */
  longWindow: CustomAlertWindow;
  /** Don't fire while the query result is below this value. */
  minimumThreshold?: number;
}

/**
 * When a custom alert fires.
 */
export type CustomAlertTrigger =
  | CustomAlertThresholdTrigger
  | CustomAlertAnomalyTrigger
  | CustomAlertSloTrigger;

export interface CustomAlertProps {
  /**
   * Name of the alert. If omitted, a unique name is generated.
   * Mutable — renames are applied in place.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Optional human-readable description of the alert.
   */
  description?: string;
  /**
   * A [SQL API](https://developers.cloudflare.com/analytics/sql-api/) query
   * returning the number the trigger evaluates, e.g.
   * `SELECT count() AS value FROM logs.workersLogs WHERE …`. The query must
   * scope itself to the account (`accountTag = '…'`). Cloudflare checks
   * it when the alert is saved and rejects it with `InvalidAlertQuery`.
   */
  query: string;
  /** When the alert fires. */
  trigger: CustomAlertTrigger;
  /**
   * How often Cloudflare runs the query.
   * @default "1m"
   */
  every?: CustomAlertWindow;
  /**
   * Destinations notified when the alert fires. At least one destination is
   * required, either declared here or bound by a runtime that consumes the
   * alert's notifications (`Cloudflare.Alerting.consumeNotifications`).
   */
  mechanisms?: NotificationPolicyMechanisms;
  /**
   * How often to re-alert while the alert keeps firing (e.g. `"30m"`).
   */
  alertInterval?: string;
  /**
   * Whether the alert is enabled.
   * @default true
   */
  enabled?: boolean;
}

export interface CustomAlertAttributes {
  /** Cloudflare-assigned notification policy UUID. */
  policyId: string;
  /** Account that owns this alert. */
  accountId: string;
  /** Name of the alert. */
  name: string;
  /** Whether the alert is enabled. */
  enabled: boolean;
  /** ISO8601 creation timestamp. */
  created: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modified: string | undefined;
}

export type CustomAlert = Resource<
  TypeId,
  CustomAlertProps,
  CustomAlertAttributes,
  NotificationPolicyBinding,
  Providers
>;

/**
 * A Cloudflare custom alert: a SQL query Cloudflare runs on a schedule,
 * with a trigger that decides when to notify.
 *
 * The query runs against the
 * [SQL API](https://developers.cloudflare.com/analytics/sql-api/), so it
 * can read Workers logs and traces, HTTP requests, Analytics Engine
 * datasets and the other analytics datasets. Notifications go to the same
 * destinations as a `NotificationPolicy` (email, webhooks, PagerDuty).
 * ### Alerting on a threshold
 * **Example:** Alert when a Worker logs more than 100 errors in 5 minutes
 * ```typescript
 * yield* Cloudflare.Alerting.CustomAlert("ErrorSpike", {
 *   query: `SELECT count() AS value FROM logs.workersLogs
 *           WHERE accountTag = '${accountId}' AND level = 'error'`,
 *   trigger: { type: "threshold", operator: ">", value: 100, window: "5m" },
 *   every: "5m",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 * ```
 *
 * ### Alerting on anomalies
 * **Example:** Alert when request volume spikes or drops
 * ```typescript
 * yield* Cloudflare.Alerting.CustomAlert("TrafficAnomaly", {
 *   query: `SELECT count() AS value FROM events.httpRequests
 *           WHERE accountTag = '${accountId}'`,
 *   trigger: {
 *     type: "anomaly",
 *     direction: "both",
 *     zScore: 3,
 *     window: "5m",
 *     baselineWindow: "1h",
 *   },
 *   mechanisms: { webhooks: [{ id: webhook.webhookId }] },
 * });
 * ```
 *
 * ### Alerting on an SLO
 * **Example:** Alert when the success rate drops below 99.9%
 * ```typescript
 * yield* Cloudflare.Alerting.CustomAlert("Availability", {
 *   query: `SELECT 100 * countIf(httpStatus < 500) / count() AS value
 *           FROM logs.workersLogs WHERE accountTag = '${accountId}'`,
 *   trigger: { type: "slo", target: 99.9, shortWindow: "5m", longWindow: "1h" },
 *   mechanisms: { pagerduty: [{ id: pagerDutyId }] },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/notifications/
 *
 * @resource
 * @product Alerting
 * @category Observability & Analytics
 */
export const CustomAlert = Resource<CustomAlert>(TypeId);

/**
 * Returns true if the given value is a CustomAlert resource.
 */
export const isCustomAlert = (value: unknown): value is CustomAlert =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CustomAlertProvider = () =>
  Provider.succeed(CustomAlert, {
    stables: ["policyId", "accountId"],

    // Account-scoped collection: the account's `custom_analytics` policies.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* alerting.listPolicies.items({ accountId }).pipe(
        Stream.filter((p) => p.alertType === "custom_analytics"),
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk)
            .map(narrowPolicy)
            .filter((p): p is ObservedPolicy => p !== undefined)
            .map((p) => toAttributes(p, accountId)),
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

      // Owned path: refresh by the persisted policy id.
      if (output?.policyId) {
        const observed = yield* observePolicy(acct, output.policyId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold read: no persisted id (state-persistence failure) — find the
      // deterministic physical name in the account's policy list.
      const name = yield* createPolicyName(id, olds?.name);
      const match = yield* findPolicyByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createPolicyName(id, news.name ?? output?.name);
      const desired = buildBody(name, news, bindings);

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
        const created = yield* alerting.createPolicy({ accountId, ...desired });
        if (!created.id) {
          return yield* new CustomAlertUnexpectedResponse({
            message: "Cloudflare did not return an id for the created custom alert",
          });
        }
        const fresh = yield* observePolicy(accountId, created.id);
        return toAttributes(fresh ?? { id: created.id, name }, accountId);
      }

      // 3. Sync — PUT the full desired body when anything drifts from the
      //    observed policy, filters included.
      if (!policyEqualsObserved(desired, observed)) {
        yield* alerting.updatePolicy({ accountId, policyId: observed.id, ...desired });
        const fresh = yield* observePolicy(accountId, observed.id);
        return toAttributes(fresh ?? observed, accountId);
      }

      // 4. Return.
      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* alerting
        .deletePolicy({ accountId: output.accountId, policyId: output.policyId })
        .pipe(Effect.catchTag("PolicyNotFound", () => Effect.void));
    }),
  });

const buildBody = (
  name: string,
  news: CustomAlertProps,
  bindings: ReadonlyArray<{ data: NotificationPolicyBinding }>,
): PolicyBody => ({
  name,
  alertType: "custom_analytics",
  enabled: news.enabled ?? true,
  description: news.description,
  alertInterval: news.alertInterval,
  // `Input<string>` ids are resolved to concrete strings by the engine
  // before reconcile runs; bound webhooks extend the declared ones.
  mechanisms: boundMechanisms(news.mechanisms, bindings),
  filters: {
    source: ["sql_api"],
    selectors: [news.query],
    // Cloudflare stores 1m when omitted; send it so observed state matches.
    executionInterval: [news.every ?? "1m"],
    ...triggerFilters(news.trigger),
  },
});

const ZSCORE_ALGORITHMS = {
  spike: "zscore_spike",
  drop: "zscore_drop",
  both: "zscore_spike_and_drop",
} as const;

/**
 * Encode a trigger as the `alert_trigger_preferences*` filters. Anomaly
 * and SLO triggers only accept the `<` operator, so it is fixed here.
 */
const triggerFilters = (trigger: CustomAlertTrigger): NonNullable<PolicyBody["filters"]> => {
  const minimum =
    trigger.minimumThreshold === undefined
      ? {}
      : { alertTriggerPreferencesMinimumThreshold: [String(trigger.minimumThreshold)] };
  switch (trigger.type) {
    case "threshold":
      return {
        alertTriggerPreferences: ["threshold"],
        alertTriggerPreferencesOperator: [trigger.operator],
        alertTriggerPreferencesValue: [String(trigger.value)],
        alertTriggerPreferencesShortWindow: [trigger.window],
        ...minimum,
      };
    case "anomaly":
      return {
        alertTriggerPreferences: [ZSCORE_ALGORITHMS[trigger.direction]],
        alertTriggerPreferencesOperator: ["<"],
        alertTriggerPreferencesValue: [String(trigger.zScore)],
        alertTriggerPreferencesShortWindow: [trigger.window],
        alertTriggerPreferencesLongWindow: [trigger.baselineWindow],
        ...minimum,
      };
    case "slo":
      return {
        alertTriggerPreferences: ["slo"],
        alertTriggerPreferencesOperator: ["<"],
        alertTriggerPreferencesValue: [String(trigger.target)],
        alertTriggerPreferencesShortWindow: [trigger.shortWindow],
        alertTriggerPreferencesLongWindow: [trigger.longWindow],
        ...minimum,
      };
  }
};

const toAttributes = (observed: ObservedPolicy, accountId: string): CustomAlertAttributes => ({
  policyId: observed.id,
  accountId,
  name: observed.name ?? "",
  enabled: observed.enabled ?? true,
  created: observed.created,
  modified: observed.modified,
});
