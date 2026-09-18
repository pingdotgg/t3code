import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetBillingMeters,
  GetBillingMeter,
  CreateBillingMeter,
  UpdateBillingMeter,
  CreateBillingMeterDeactivate,
  CreateBillingMeterReactivate,
  type BillingMeter as StripeBillingMeter,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const DISPLAY_NAME_MAX_LENGTH = 250;
const EVENT_NAME_MAX_LENGTH = 100;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** How meter events are aggregated over a billing period. */
export type BillingMeterAggregationFormula = "count" | "last" | "sum";

/** The meter's status. Inactive meters reject events and cannot attach to a price. */
export type BillingMeterStatus = "active" | "inactive";

/** Pre-aggregation window for meter events, if any. */
export type BillingMeterEventTimeWindow = "day" | "hour";

/** How a meter event is mapped to a Stripe customer. */
export type BillingMeterCustomerMappingType = "by_id";

export interface BillingMeterDefaultAggregation {
  /**
   * Aggregation formula applied to events over the billing period.
   */
  formula: BillingMeterAggregationFormula;
}

export interface BillingMeterCustomerMapping {
  /**
   * Key in the meter event payload used to map the event to a customer.
   */
  eventPayloadKey: string;
  /**
   * Mapping method. Must be `by_id`.
   * @default "by_id"
   */
  type?: BillingMeterCustomerMappingType;
}

export interface BillingMeterValueSettings {
  /**
   * Key in the usage event payload used as this meter's value (e.g.
   * `"bytes_used"`).
   */
  eventPayloadKey: string;
}

export interface BillingMeterProps {
  /**
   * The meter's name. Not visible to the customer. If omitted, a unique
   * name is generated from the stack, stage, and logical id. Mutable.
   */
  displayName?: string;
  /**
   * Name of the meter event used to record usage. Corresponds with the
   * `event_name` field on meter events. If omitted, a unique name is
   * generated. Create-only — changing it replaces the meter. Stripe
   * event names are unique per account, including deactivated meters.
   */
  eventName?: string;
  /**
   * How events are aggregated over a billing period. Create-only.
   */
  defaultAggregation: BillingMeterDefaultAggregation;
  /**
   * How a meter event is mapped to a customer. Create-only. Defaults to
   * `{ type: "by_id", eventPayloadKey: "stripe_customer_id" }`.
   */
  customerMapping?: BillingMeterCustomerMapping;
  /**
   * Pre-aggregation window for meter events. Create-only.
   */
  eventTimeWindow?: BillingMeterEventTimeWindow;
  /**
   * How to calculate a meter event's value. Create-only. Defaults to
   * `{ eventPayloadKey: "value" }`.
   */
  valueSettings?: BillingMeterValueSettings;
  /**
   * Whether the meter accepts events and can attach to a price.
   * @default "active"
   */
  status?: BillingMeterStatus;
}

export type BillingMeter = Resource<
  "Stripe.BillingMeter",
  BillingMeterProps,
  {
    /** Stripe billing meter id (`mtr_…`). */
    id: string;
    /** The meter's name. Not visible to the customer. */
    displayName: string;
    /** Name of the meter event used to record usage. */
    eventName: string;
    /** How events are aggregated over a billing period. */
    defaultAggregation: BillingMeterDefaultAggregation;
    /** How a meter event is mapped to a customer. */
    customerMapping: BillingMeterCustomerMapping;
    /** Pre-aggregation window for meter events, if any. */
    eventTimeWindow: BillingMeterEventTimeWindow | undefined;
    /** How to calculate a meter event's value. */
    valueSettings: BillingMeterValueSettings;
    /** Whether the meter accepts events and can attach to a price. */
    status: BillingMeterStatus;
    /** Unix timestamp when the meter was created. */
    created: number;
    /** Unix timestamp when the meter was last updated. */
    updated: number;
    /** Whether the meter exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Billing Meter — how usage events are aggregated over a billing
 * period for usage-based prices. `eventName`, `defaultAggregation`,
 * `customerMapping`, `eventTimeWindow`, and `valueSettings` are immutable.
 * Changing `eventName` replaces the meter. Display name updates in place;
 * `status` is changed with Stripe's activate/deactivate endpoints.
 *
 * Billing meters have no metadata field and cannot be hard-deleted.
 * Destroying this resource deactivates the meter. Deactivated meters
 * still occupy their `eventName`, so a later deploy with the same event
 * name reactivates the existing meter.
 *
 * @see https://docs.stripe.com/api/billing/meter
 *
 * ### Creating a Billing Meter
 * **Example:** Sum aggregation
 * ```typescript
 * const apiCalls = yield* Stripe.BillingMeter("api-calls", {
 *   displayName: "API Calls",
 *   eventName: "api_call",
 *   defaultAggregation: { formula: "sum" },
 * });
 * ```
 *
 * **Example:** Count with custom value key
 * ```typescript
 * const tokens = yield* Stripe.BillingMeter("tokens", {
 *   displayName: "Tokens",
 *   eventName: "token_used",
 *   defaultAggregation: { formula: "count" },
 *   valueSettings: { eventPayloadKey: "tokens" },
 *   customerMapping: {
 *     type: "by_id",
 *     eventPayloadKey: "stripe_customer_id",
 *   },
 * });
 * ```
 *
 * ### Updating a Billing Meter
 * **Example:** Rename the meter
 * ```typescript
 * const apiCalls = yield* Stripe.BillingMeter("api-calls", {
 *   displayName: "API Calls (updated)",
 *   eventName: "api_call",
 *   defaultAggregation: { formula: "sum" },
 * });
 * ```
 *
 * ### Deactivating a Billing Meter
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal calls deactivate
 * const apiCalls = yield* Stripe.BillingMeter("api-calls", {
 *   displayName: "API Calls",
 *   eventName: "api_call",
 *   defaultAggregation: { formula: "sum" },
 * });
 * ```
 *
 * @resource
 */
export const BillingMeter = Resource<BillingMeter>("Stripe.BillingMeter");

export class BillingMeterNotResolved extends Data.TaggedError(
  "Stripe.BillingMeterNotResolved",
)<{
  eventName: string;
}> {}

type BillingMeterAttributes = BillingMeter["Attributes"];

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: DISPLAY_NAME_MAX_LENGTH }))
    );
  });

const toEventName = (
  id: string,
  eventName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      eventName ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: EVENT_NAME_MAX_LENGTH,
        lowercase: true,
        delimiter: "_",
      }))
    );
  });

const toAttrs = (meter: StripeBillingMeter): BillingMeterAttributes => ({
  id: meter.id,
  displayName: meter.display_name,
  eventName: meter.event_name,
  defaultAggregation: { formula: meter.default_aggregation.formula },
  customerMapping: {
    eventPayloadKey: meter.customer_mapping.event_payload_key,
    type: meter.customer_mapping.type,
  },
  eventTimeWindow: meter.event_time_window ?? undefined,
  valueSettings: {
    eventPayloadKey: meter.value_settings.event_payload_key,
  },
  status: meter.status,
  created: meter.created,
  updated: meter.updated,
  livemode: meter.livemode,
});

const isMissingMeter = isMissingStripeResource;

const getById = (id: string) =>
  GetBillingMeter({ id }).pipe(
    Effect.catchIf(isMissingMeter, () => Effect.succeed(undefined)),
  );

const listByStatus = Effect.fn(function* (status: BillingMeterStatus) {
  const meters: StripeBillingMeter[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetBillingMeters({
      status,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    meters.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return meters;
});

const listAllMeters = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByStatus("active"), listByStatus("inactive")],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const meters: StripeBillingMeter[] = [];
  for (const meter of [...active, ...inactive]) {
    if (seen.has(meter.id)) continue;
    seen.add(meter.id);
    meters.push(meter);
  }
  return meters;
});

const findByEventName = Effect.fn(function* (eventName: string) {
  const meters = yield* listAllMeters();
  const matches = meters.filter((meter) => meter.event_name === eventName);
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  eventName?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.eventName !== undefined) {
    return yield* findByEventName(input.eventName);
  }
  return undefined;
});

const shouldReplace = (
  news: BillingMeterProps,
  output: BillingMeterAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.eventName !== undefined && news.eventName !== output.eventName) {
    return true;
  }
  return false;
};

export const BillingMeterProvider = () =>
  Provider.succeed(BillingMeter, {
    stables: [
      "id",
      "eventName",
      "defaultAggregation",
      "customerMapping",
      "eventTimeWindow",
      "valueSettings",
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

    read: Effect.fn(function* ({ output }) {
      const existing = yield* observe({
        id: output?.id,
        eventName: output?.eventName,
      });
      if (existing === undefined) return undefined;
      // Billing meters have no metadata. Identity is the Stripe id and the
      // unique event_name; a match is treated as owned.
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. Default list is active meters;
      // deactivated rows stay in Stripe (event_name remains reserved) but
      // must not re-enter nuke.
      const meters = yield* listByStatus("active");
      return meters.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const eventName = yield* toEventName(
        id,
        news.eventName,
        output?.eventName,
      );
      const desiredStatus = news.status ?? "active";

      let current = yield* observe({
        id: output?.id,
        eventName,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateBillingMeter({
          display_name: displayName,
          event_name: eventName,
          default_aggregation: { formula: news.defaultAggregation.formula },
          ...(news.customerMapping !== undefined
            ? {
                customer_mapping: {
                  event_payload_key: news.customerMapping.eventPayloadKey,
                  type: news.customerMapping.type ?? "by_id",
                },
              }
            : {}),
          ...(news.eventTimeWindow !== undefined
            ? { event_time_window: news.eventTimeWindow }
            : {}),
          ...(news.valueSettings !== undefined
            ? {
                value_settings: {
                  event_payload_key: news.valueSettings.eventPayloadKey,
                },
              }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-billing-meter-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new BillingMeterNotResolved({ eventName });
      }

      const displayNameChanged = current.display_name !== displayName;
      if (displayNameChanged) {
        current = yield* UpdateBillingMeter({
          id: current.id,
          display_name: displayName,
        });
      }

      if (current.status !== desiredStatus) {
        current =
          desiredStatus === "inactive"
            ? yield* CreateBillingMeterDeactivate({ id: current.id })
            : yield* CreateBillingMeterReactivate({ id: current.id });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || existing.status === "inactive") return;
      yield* CreateBillingMeterDeactivate({ id: existing.id }).pipe(
        Effect.catchIf(isMissingMeter, () => Effect.void),
      );
    }),
  });
