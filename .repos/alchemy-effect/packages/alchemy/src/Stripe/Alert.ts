import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetBillingAlerts,
  GetBillingAlert,
  CreateBillingAlert,
  CreateBillingAlertActivate,
  CreateBillingAlertArchive,
  CreateBillingAlertDeactivate,
  type BillingAlert as StripeBillingAlert,
  type ThresholdsResourceUsageAlertFilterCustomer,
  type ThresholdsResourceUsageThresholdConfig,
  type ThresholdsResourceUsageThresholdConfigMeter,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const TITLE_MAX_LENGTH = 256;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The type of billing alert. Currently only usage-threshold alerts. */
export type AlertType = "usage_threshold";

/** Status of a billing alert. Archived alerts cannot be reactivated. */
export type AlertStatus = "active" | "archived" | "inactive";

/** Desired status for a managed alert. Archived is delete-only. */
export type AlertDesiredStatus = "active" | "inactive";

/** How a usage-threshold alert fires. */
export type AlertRecurrence = "one_time";

/** Restricts a usage-threshold alert to a single customer. */
export interface AlertUsageThresholdFilter {
  /**
   * Filter kind. Must be `customer`.
   */
  type: "customer";
  /**
   * Stripe Customer id (`cus_…`) this alert is limited to.
   */
  customer?: string;
}

/** Configuration for a usage-threshold billing alert. Create-only. */
export interface AlertUsageThreshold {
  /**
   * Usage value at which the alert fires. Create-only — changing it
   * replaces the alert.
   */
  gte: number;
  /**
   * Id of the Billing Meter whose usage is monitored (`mtr_…`).
   * Create-only — changing it replaces the alert.
   */
  meter: string;
  /**
   * How the alert behaves after firing.
   * @default "one_time"
   */
  recurrence?: AlertRecurrence;
  /**
   * Optional filters that limit the alert's scope. Stripe currently
   * accepts at most one `customer` filter. Create-only.
   */
  filters?: AlertUsageThresholdFilter[];
}

export interface AlertProps {
  /**
   * Title of the alert. If omitted, a unique title is generated from the
   * stack, stage, and logical id. Create-only — changing it replaces the
   * alert. Max 256 characters.
   */
  title?: string;
  /**
   * Type of alert to create.
   * @default "usage_threshold"
   */
  alertType?: AlertType;
  /**
   * Usage-threshold configuration. Create-only — changing `gte`, `meter`,
   * `recurrence`, or `filters` replaces the alert.
   */
  usageThreshold: AlertUsageThreshold;
  /**
   * Whether the alert can fire. `inactive` deactivates in place (and can
   * be reactivated). Destroy archives the alert (irreversible).
   * @default "active"
   */
  status?: AlertDesiredStatus;
}

export type Alert = Resource<
  "Stripe.Alert",
  AlertProps,
  {
    /** Stripe billing alert id (`alrt_…`). */
    id: string;
    /** Title of the alert. */
    title: string;
    /** Type of the alert. */
    alertType: AlertType;
    /** Status of the alert. */
    status: AlertStatus;
    /** Usage-threshold configuration, if set. */
    usageThreshold: AlertUsageThreshold | undefined;
    /** Whether the alert exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Billing Alert — notifies you when a usage threshold on a
 * [Billing Meter](https://docs.stripe.com/api/billing/meter) is crossed.
 * `title`, `alertType`, and `usageThreshold` are immutable; changing them
 * replaces the alert. `status` is changed with Stripe's activate/deactivate
 * endpoints.
 *
 * Billing alerts have no metadata field and cannot be hard-deleted.
 * Destroying this resource archives the alert (irreversible). Archived
 * alerts leave the list API and cannot be reactivated.
 *
 * @see https://docs.stripe.com/api/billing/alert
 *
 * ### Creating an Alert
 * **Example:** Usage threshold on a meter
 * ```typescript
 * const apiCalls = yield* Stripe.BillingMeter("api-calls", {
 *   displayName: "API Calls",
 *   eventName: "api_call",
 *   defaultAggregation: { formula: "sum" },
 * });
 * const highUsage = yield* Stripe.Alert("high-usage", {
 *   title: "API Request usage alert",
 *   usageThreshold: {
 *     gte: 10000,
 *     meter: apiCalls.id,
 *     recurrence: "one_time",
 *   },
 * });
 * ```
 *
 * **Example:** Limit the alert to one customer
 * ```typescript
 * const highUsage = yield* Stripe.Alert("high-usage", {
 *   title: "Customer API usage alert",
 *   usageThreshold: {
 *     gte: 1000,
 *     meter: apiCalls.id,
 *     recurrence: "one_time",
 *     filters: [{ type: "customer", customer: customer.id }],
 *   },
 * });
 * ```
 *
 * ### Updating an Alert
 * **Example:** Deactivate without archiving
 * ```typescript
 * const highUsage = yield* Stripe.Alert("high-usage", {
 *   title: "API Request usage alert",
 *   usageThreshold: {
 *     gte: 10000,
 *     meter: apiCalls.id,
 *     recurrence: "one_time",
 *   },
 *   status: "inactive",
 * });
 * ```
 *
 * ### Archiving an Alert
 * **Example:** Destroy archives rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal archives the alert
 * const highUsage = yield* Stripe.Alert("high-usage", {
 *   title: "API Request usage alert",
 *   usageThreshold: {
 *     gte: 10000,
 *     meter: apiCalls.id,
 *     recurrence: "one_time",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Alert = Resource<Alert>("Stripe.Alert");

export class AlertNotResolved extends Data.TaggedError(
  "Stripe.AlertNotResolved",
)<{
  title: string;
}> {}

type AlertAttributes = Alert["Attributes"];

const toTitle = (id: string, title: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      title ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: TITLE_MAX_LENGTH }))
    );
  });

const toMeterId = (
  meter: ThresholdsResourceUsageThresholdConfigMeter,
): string => (typeof meter === "string" ? meter : meter.id);

const toCustomerId = (
  customer: ThresholdsResourceUsageAlertFilterCustomer | null,
): string | undefined => {
  if (customer == null) return undefined;
  if (typeof customer === "string") return customer;
  return customer.id;
};

const toUsageThreshold = (
  config: ThresholdsResourceUsageThresholdConfig | null,
): AlertUsageThreshold | undefined => {
  if (config === null) return undefined;
  const filters = (config.filters ?? []).map((filter) => {
    const customer = toCustomerId(filter.customer);
    return customer !== undefined
      ? { type: filter.type, customer }
      : { type: filter.type };
  });
  return {
    gte: config.gte,
    meter: toMeterId(config.meter),
    recurrence: config.recurrence,
    ...(filters.length > 0 ? { filters } : {}),
  };
};

const toAttrs = (alert: StripeBillingAlert): AlertAttributes => ({
  id: alert.id,
  title: alert.title,
  alertType: alert.alert_type,
  status: alert.status ?? "active",
  usageThreshold: toUsageThreshold(alert.usage_threshold),
  livemode: alert.livemode,
});

const isMissingAlert = isMissingStripeResource;

const getById = (id: string) =>
  GetBillingAlert({ id }).pipe(
    Effect.catchIf(isMissingAlert, () => Effect.succeed(undefined)),
  );

const listAlerts = Effect.fn(function* () {
  const alerts: StripeBillingAlert[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetBillingAlerts({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    alerts.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return alerts;
});

const findByTitle = Effect.fn(function* (title: string) {
  const alerts = yield* listAlerts();
  return alerts.find((alert) => alert.title === title);
});

const isArchived = (alert: StripeBillingAlert): boolean =>
  alert.status === "archived";

const observe = Effect.fn(function* (input: { id?: string; title?: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined && !isArchived(byId)) return byId;
  }
  if (input.title !== undefined) {
    return yield* findByTitle(input.title);
  }
  return undefined;
});

const filtersEqual = (
  a: AlertUsageThresholdFilter[] | undefined,
  b: AlertUsageThresholdFilter[] | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const other = right[i];
    if (
      other === undefined ||
      left[i]?.type !== other.type ||
      left[i]?.customer !== other.customer
    ) {
      return false;
    }
  }
  return true;
};

const shouldReplace = (
  news: AlertProps,
  output: AlertAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.title !== undefined && news.title !== output.title) return true;
  if (news.alertType !== undefined && news.alertType !== output.alertType) {
    return true;
  }
  const current = output.usageThreshold;
  if (current === undefined) return true;
  if (news.usageThreshold.gte !== current.gte) return true;
  if (news.usageThreshold.meter !== current.meter) return true;
  const desiredRecurrence = news.usageThreshold.recurrence ?? "one_time";
  if (desiredRecurrence !== current.recurrence) return true;
  if (
    news.usageThreshold.filters !== undefined &&
    !filtersEqual(news.usageThreshold.filters, current.filters)
  ) {
    return true;
  }
  return false;
};

const toCreateUsageThreshold = (threshold: AlertUsageThreshold) => ({
  gte: threshold.gte,
  meter: threshold.meter,
  recurrence: threshold.recurrence ?? "one_time",
  ...(threshold.filters !== undefined
    ? {
        filters: threshold.filters.map((filter) => ({
          type: filter.type,
          ...(filter.customer !== undefined
            ? { customer: filter.customer }
            : {}),
        })),
      }
    : {}),
});

export const AlertProvider = () =>
  Provider.succeed(Alert, {
    stables: ["id", "title", "alertType", "usageThreshold", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const existing = yield* observe({
        id: output?.id,
        title: output?.title,
      });
      if (existing === undefined) return undefined;
      // Billing alerts have no metadata. Identity is the Stripe id and
      // title; a match is treated as owned.
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. The list API returns active and
      // inactive alerts; archived rows stay in Stripe but leave the list
      // and must not re-enter nuke.
      const alerts = yield* listAlerts();
      return alerts.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const title = yield* toTitle(id, news.title, output?.title);
      const alertType = news.alertType ?? "usage_threshold";
      const desiredStatus = news.status ?? "active";

      let current = yield* observe({
        id: output?.id,
        title,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateBillingAlert({
          alert_type: alertType,
          title,
          usage_threshold: toCreateUsageThreshold(news.usageThreshold),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-billing-alert-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new AlertNotResolved({ title });
      }

      const currentStatus = current.status ?? "active";
      if (currentStatus !== desiredStatus) {
        current =
          desiredStatus === "inactive"
            ? yield* CreateBillingAlertDeactivate({ id: current.id })
            : yield* CreateBillingAlertActivate({ id: current.id });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || existing.status === "archived") return;
      yield* CreateBillingAlertArchive({ id: existing.id }).pipe(
        Effect.catchIf(isMissingAlert, () => Effect.void),
      );
    }),
  });
