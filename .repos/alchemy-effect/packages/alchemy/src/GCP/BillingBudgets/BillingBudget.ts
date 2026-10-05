import * as billingbudgets from "@distilled.cloud/gcp/billingbudgets_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  billingAccountIdOf,
  billingAccountParent,
  budgetNameOf,
  compact,
  filterChanged,
  findBudgetByDisplayName,
  generatedDisplayName,
  getBudget,
  jsonEqual,
  parseBudgetName,
  resolveBillingAccountId,
  resolveProjectRefs,
  sortedStrings,
} from "./internal.ts";

export type Money = {
  /**
   * Whole units of the amount. For USD, `1` is one dollar.
   */
  units?: string;
  /**
   * ISO 4217 currency code. If set on create, it must match the billing
   * account currency.
   */
  currencyCode?: string;
  /**
   * Nano (10^-9) units of the amount. Must be between -999,999,999 and
   * 999,999,999.
   */
  nanos?: number;
};

export type BudgetAmount = {
  /**
   * Use last calendar period's actual spend as this period's budget.
   * Cannot be combined with `customPeriod`. Empty object selects this
   * mode.
   */
  lastPeriodAmount?: Record<string, never> | {};
  /**
   * Explicit budgeted amount. `currencyCode` is optional on create and
   * must match the billing account (and the existing budget on update).
   */
  specifiedAmount?: Money;
};

export type CustomPeriod = {
  /**
   * Inclusive start date. Must be after 2017-01-01.
   */
  startDate?: { year?: number; month?: number; day?: number };
  /**
   * Inclusive end date. Budgets past this date are not processed. Omit
   * to track all usage since `startDate`.
   */
  endDate?: { year?: number; month?: number; day?: number };
};

export type BudgetFilter = {
  /**
   * Folders and organizations whose usage is included, as
   * `folders/{folderId}` or `organizations/{organizationId}`.
   */
  resourceAncestors?: string[];
  /**
   * Subaccounts of the form `billingAccounts/{account_id}`.
   */
  subaccounts?: string[];
  /**
   * Recurring calendar period (`MONTH`, `QUARTER`, `YEAR`). Default
   * `MONTH` when `customPeriod` is unset.
   */
  calendarPeriod?: string;
  /**
   * Services of the form `services/{service_id}`.
   */
  services?: string[];
  /**
   * Credit types subtracted from gross cost when
   * `creditTypesTreatment` is `INCLUDE_SPECIFIED_CREDITS`.
   */
  creditTypes?: string[];
  /**
   * How credits are treated (`INCLUDE_ALL_CREDITS`,
   * `EXCLUDE_ALL_CREDITS`, `INCLUDE_SPECIFIED_CREDITS`).
   */
  creditTypesTreatment?: string;
  /**
   * Projects of the form `projects/{project}`. Omit to include every
   * project the billing account pays for.
   */
  projects?: string[];
  /**
   * Static (non-recurring) time period. Mutually exclusive with
   * `calendarPeriod`.
   */
  customPeriod?: CustomPeriod;
  /**
   * Single resource-label key mapped to a list of values. Usage from
   * only those labeled resources is included.
   */
  labels?: Record<string, unknown[] | undefined>;
};

export type ThresholdRule = {
  /**
   * Alert when spend exceeds this fraction of the budget (`0.5` is 50%).
   */
  thresholdPercent?: number;
  /**
   * Spend basis (`CURRENT_SPEND` or `FORECASTED_SPEND`). Defaults to
   * `CURRENT_SPEND`.
   */
  spendBasis?: string;
};

export type NotificationsRule = {
  /**
   * Schema version of Pub/Sub notifications. Only `"1.0"` is accepted.
   */
  schemaVersion?: string;
  /**
   * Pub/Sub topic for programmatic notifications, as
   * `projects/{project}/topics/{topic}`.
   */
  pubsubTopic?: string;
  /**
   * When true, default IAM billing-account recipients are not emailed.
   */
  disableDefaultIamRecipients?: boolean;
  /**
   * When true and the budget tracks a single project, also notify that
   * project's Owners.
   */
  enableProjectLevelRecipients?: boolean;
  /**
   * Cloud Monitoring email notification channels, as
   * `projects/{project}/notificationChannels/{channel}`. Max 5.
   */
  monitoringNotificationChannels?: string[];
};

export type BillingBudgetProps = {
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the budget.
   */
  billingAccountId?: string;
  /**
   * Server-assigned budget id (the `{budget}` segment of
   * `billingAccounts/{billingAccount}/budgets/{budget}`). Omit on
   * create; pass the observed id to update in place. Immutable —
   * changing it replaces the budget.
   */
  budgetId?: string;
  /**
   * User-visible display name (60 characters), shown in budget alert
   * emails. If omitted, a unique name is generated from the stack, stage,
   * and logical id.
   */
  displayName?: string;
  /**
   * Budgeted amount. Required. Either `specifiedAmount` or
   * `lastPeriodAmount`.
   */
  amount: BudgetAmount;
  /**
   * Filters that scope actual spend (projects, services, period, …).
   */
  budgetFilter?: BudgetFilter;
  /**
   * Thresholds that trigger alert emails and populate Pub/Sub payloads.
   */
  thresholdRules?: ThresholdRule[];
  /**
   * Notification targets (email channels and/or Pub/Sub).
   */
  notificationsRule?: NotificationsRule;
  /**
   * Who owns the budget (`ALL_USERS` or `BILLING_ACCOUNT`).
   */
  ownershipScope?: string;
};

export type BillingBudget = Resource<
  "GCP.BillingBudgets.BillingBudget",
  BillingBudgetProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/budgets/{budget}`. */
    name: string;
    /** Server-assigned budget id (last path segment). */
    budgetId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Display name. */
    displayName: string | undefined;
    /** Budgeted amount. */
    amount: BudgetAmount | undefined;
    /** Spend filter. */
    budgetFilter: BudgetFilter | undefined;
    /** Threshold rules. */
    thresholdRules: ThresholdRule[];
    /** Notification rules. */
    notificationsRule: NotificationsRule | undefined;
    /** Ownership scope. */
    ownershipScope: string | undefined;
    /** Server etag for read-modify-write. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Billing budget.
 *
 * Budgets have no labels field and the display name appears in alert
 * emails, so Alchemy finds its budget by display name within the current
 * project's scope: `read` reports a budget as owned only when it carries
 * the generated name (an explicit `displayName` is reported as unowned —
 * adopt it with `--adopt`), and nuke cannot discover budgets. The
 * physical id is a server-assigned UUID. Changing `billingAccountId` or
 * `budgetId` replaces the budget. Amount, filter, thresholds,
 * notifications, and display name update in place.
 *
 * ### Creating a Budget
 * **Example:** Project-scoped monthly budget
 * ```typescript
 * const budget = yield* GCP.BillingBudgets.BillingBudget("Spend", {
 *   displayName: "cap",
 *   amount: { specifiedAmount: { currencyCode: "USD", units: "10" } },
 *   budgetFilter: {
 *     projects: ["projects/my-project"],
 *     calendarPeriod: "MONTH",
 *   },
 *   thresholdRules: [{ thresholdPercent: 0.5, spendBasis: "CURRENT_SPEND" }],
 * });
 * ```
 *
 * **Example:** Last-period amount
 * ```typescript
 * const budget = yield* GCP.BillingBudgets.BillingBudget("Spend", {
 *   amount: { lastPeriodAmount: {} },
 *   budgetFilter: { calendarPeriod: "MONTH" },
 * });
 * ```
 *
 * ### Updating a Budget
 * **Example:** Raise the cap and add a forecasted threshold
 * ```typescript
 * const budget = yield* GCP.BillingBudgets.BillingBudget("Spend", {
 *   displayName: "cap",
 *   amount: { specifiedAmount: { currencyCode: "USD", units: "25" } },
 *   budgetFilter: {
 *     projects: ["projects/my-project"],
 *     calendarPeriod: "MONTH",
 *   },
 *   thresholdRules: [
 *     { thresholdPercent: 0.5, spendBasis: "CURRENT_SPEND" },
 *     { thresholdPercent: 0.9, spendBasis: "FORECASTED_SPEND" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category BillingBudgets
 */
export const BillingBudget = Resource<BillingBudget>(
  "GCP.BillingBudgets.BillingBudget",
);

export class BillingBudgetNotResolved extends Data.TaggedError(
  "GCP.BillingBudgets.BillingBudgetNotResolved",
)<{
  name: string;
}> {}

const toMoney = (
  money: billingbudgets.GoogleTypeMoney | Money | undefined,
): Money | undefined => {
  if (money === undefined) return undefined;
  if (
    money.units === undefined &&
    money.currencyCode === undefined &&
    money.nanos === undefined
  ) {
    return undefined;
  }
  return compact({
    units: money.units,
    currencyCode: money.currencyCode,
    nanos: money.nanos === 0 ? undefined : money.nanos,
  });
};

const toAmount = (
  amount:
    | billingbudgets.GoogleCloudBillingBudgetsV1BudgetAmount
    | BudgetAmount
    | undefined,
): BudgetAmount | undefined => {
  if (amount === undefined) return undefined;
  const specifiedAmount = toMoney(amount.specifiedAmount);
  const lastPeriodAmount =
    amount.lastPeriodAmount !== undefined ? {} : undefined;
  if (specifiedAmount === undefined && lastPeriodAmount === undefined) {
    return undefined;
  }
  return compact({ specifiedAmount, lastPeriodAmount });
};

const toDate = (
  date: billingbudgets.GoogleTypeDate | CustomPeriod["startDate"] | undefined,
): CustomPeriod["startDate"] | undefined => {
  if (date === undefined) return undefined;
  if (
    date.year === undefined &&
    date.month === undefined &&
    date.day === undefined
  ) {
    return undefined;
  }
  return compact({ year: date.year, month: date.month, day: date.day });
};

const toCustomPeriod = (
  period:
    | billingbudgets.GoogleCloudBillingBudgetsV1CustomPeriod
    | CustomPeriod
    | undefined,
): CustomPeriod | undefined => {
  if (period === undefined) return undefined;
  const startDate = toDate(period.startDate);
  const endDate = toDate(period.endDate);
  if (startDate === undefined && endDate === undefined) return undefined;
  return compact({ startDate, endDate });
};

const toFilter = (
  filter:
    | billingbudgets.GoogleCloudBillingBudgetsV1Filter
    | BudgetFilter
    | undefined,
): BudgetFilter | undefined => {
  if (filter === undefined) return undefined;
  const next = compact({
    resourceAncestors: filter.resourceAncestors
      ? sortedStrings(filter.resourceAncestors)
      : undefined,
    subaccounts: filter.subaccounts
      ? sortedStrings(filter.subaccounts)
      : undefined,
    calendarPeriod: filter.calendarPeriod,
    services: filter.services ? sortedStrings(filter.services) : undefined,
    creditTypes: filter.creditTypes
      ? sortedStrings(filter.creditTypes)
      : undefined,
    creditTypesTreatment: filter.creditTypesTreatment,
    projects: filter.projects ? sortedStrings(filter.projects) : undefined,
    customPeriod: toCustomPeriod(filter.customPeriod),
    labels: filter.labels,
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

const toThresholdRules = (
  rules:
    | readonly billingbudgets.GoogleCloudBillingBudgetsV1ThresholdRule[]
    | readonly ThresholdRule[]
    | undefined,
): ThresholdRule[] =>
  (rules ?? [])
    .map((rule) =>
      compact({
        thresholdPercent: rule.thresholdPercent,
        spendBasis: rule.spendBasis ?? "CURRENT_SPEND",
      }),
    )
    .sort((left, right) => {
      const percent =
        (left.thresholdPercent ?? 0) - (right.thresholdPercent ?? 0);
      if (percent !== 0) return percent;
      return (left.spendBasis ?? "").localeCompare(right.spendBasis ?? "");
    });

const toNotifications = (
  rule:
    | billingbudgets.GoogleCloudBillingBudgetsV1NotificationsRule
    | NotificationsRule
    | undefined,
): NotificationsRule | undefined => {
  if (rule === undefined) return undefined;
  const next = compact({
    schemaVersion: rule.schemaVersion,
    pubsubTopic: rule.pubsubTopic,
    disableDefaultIamRecipients: rule.disableDefaultIamRecipients,
    enableProjectLevelRecipients: rule.enableProjectLevelRecipients,
    monitoringNotificationChannels: rule.monitoringNotificationChannels
      ? sortedStrings(rule.monitoringNotificationChannels)
      : undefined,
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

const toAttrs = (
  budget: billingbudgets.GoogleCloudBillingBudgetsV1Budget,
  billingAccountId: string,
) => {
  const name = budget.name ?? "";
  const parsed = parseBudgetName(name, billingAccountId);
  return {
    name,
    budgetId: parsed.budgetId,
    billingAccountId: parsed.billingAccountId || billingAccountId,
    displayName: budget.displayName,
    amount: toAmount(budget.amount),
    budgetFilter: toFilter(budget.budgetFilter),
    thresholdRules: toThresholdRules(budget.thresholdRules),
    notificationsRule: toNotifications(budget.notificationsRule),
    ownershipScope: budget.ownershipScope,
    etag: budget.etag,
  };
};

const desiredAmount = (
  news: BudgetAmount,
  observed: BudgetAmount | undefined,
): billingbudgets.GoogleCloudBillingBudgetsV1BudgetAmount => {
  if (news.lastPeriodAmount !== undefined) {
    return { lastPeriodAmount: {} };
  }
  const specified = news.specifiedAmount ?? {};
  return {
    specifiedAmount: compact({
      units: specified.units,
      currencyCode:
        specified.currencyCode ??
        observed?.specifiedAmount?.currencyCode ??
        "USD",
      nanos: specified.nanos,
    }),
  };
};

const toCreateBody = (
  news: BillingBudgetProps,
  displayName: string,
  observed: BudgetAmount | undefined,
): billingbudgets.GoogleCloudBillingBudgetsV1Budget =>
  compact({
    displayName,
    amount: desiredAmount(news.amount, observed),
    budgetFilter: news.budgetFilter
      ? (toFilter(news.budgetFilter) as
          | billingbudgets.GoogleCloudBillingBudgetsV1Filter
          | undefined)
      : undefined,
    thresholdRules:
      news.thresholdRules !== undefined
        ? toThresholdRules(news.thresholdRules)
        : undefined,
    notificationsRule: news.notificationsRule
      ? (toNotifications(news.notificationsRule) as
          | billingbudgets.GoogleCloudBillingBudgetsV1NotificationsRule
          | undefined)
      : undefined,
    ownershipScope: news.ownershipScope,
  }) as billingbudgets.GoogleCloudBillingBudgetsV1Budget;

export const BillingBudgetProvider = () =>
  Provider.succeed(BillingBudget, {
    stables: ["name", "budgetId", "billingAccountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.budgetId ?? output?.budgetId;
      const idChanged =
        previousId !== undefined &&
        news.budgetId !== undefined &&
        news.budgetId !== previousId;
      const previousAccount =
        olds?.billingAccountId ?? output?.billingAccountId;
      const accountChanged =
        previousAccount !== undefined &&
        news.billingAccountId !== undefined &&
        billingAccountIdOf(news.billingAccountId) !==
          billingAccountIdOf(previousAccount);
      if (!idChanged && !accountChanged) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const budgetId = output?.budgetId ?? olds?.budgetId;
      const name =
        output?.name ??
        (budgetId ? budgetNameOf(billingAccountId, budgetId) : "");
      const generated = yield* generatedDisplayName(id);
      const existing =
        (yield* getBudget(name)) ??
        (yield* findBudgetByDisplayName(
          billingAccountParent(billingAccountId),
          olds?.displayName ?? output?.displayName ?? generated,
        ));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, billingAccountId);
      return existing.displayName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const parent = billingAccountParent(billingAccountId);
      const desiredDisplayName =
        news.displayName ??
        output?.displayName ??
        (yield* generatedDisplayName(id));
      const resolvedProjects = yield* resolveProjectRefs(
        news.budgetFilter?.projects,
      );
      const desiredNews =
        resolvedProjects === undefined
          ? news
          : {
              ...news,
              budgetFilter: {
                ...news.budgetFilter,
                projects: resolvedProjects,
              },
            };

      let current = yield* getBudget(
        output?.name ??
          (news.budgetId ? budgetNameOf(billingAccountId, news.budgetId) : ""),
      );
      if (current === undefined && news.budgetId === undefined) {
        current = yield* findBudgetByDisplayName(parent, desiredDisplayName);
      }

      if (current === undefined) {
        const created = yield* billingbudgets
          .createBillingAccountsBudgets({
            parent,
            body: toCreateBody(desiredNews, desiredDisplayName, undefined),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findBudgetByDisplayName(parent, desiredDisplayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.name) {
        return yield* new BillingBudgetNotResolved({
          name: output?.name ?? `${parent}/budgets`,
        });
      }

      const observedAmount = toAmount(current.amount);
      const desiredBody = toCreateBody(
        desiredNews,
        desiredDisplayName,
        observedAmount,
      );
      const mask: string[] = [];
      if ((current.displayName ?? "") !== desiredDisplayName) {
        mask.push("displayName");
      }
      if (!jsonEqual(toAmount(current.amount), toAmount(desiredBody.amount))) {
        mask.push("amount");
      }
      if (
        desiredNews.budgetFilter !== undefined &&
        filterChanged(
          toFilter(current.budgetFilter) as Record<string, unknown> | undefined,
          toFilter(desiredNews.budgetFilter) as
            | Record<string, unknown>
            | undefined,
        )
      ) {
        mask.push("budgetFilter");
      }
      if (
        desiredNews.thresholdRules !== undefined &&
        !jsonEqual(
          toThresholdRules(current.thresholdRules),
          toThresholdRules(desiredNews.thresholdRules),
        )
      ) {
        mask.push("thresholdRules");
      }
      if (
        desiredNews.notificationsRule !== undefined &&
        !jsonEqual(
          toNotifications(current.notificationsRule),
          toNotifications(desiredNews.notificationsRule),
        )
      ) {
        mask.push("notificationsRule");
      }
      if (
        desiredNews.ownershipScope !== undefined &&
        (current.ownershipScope ?? "") !== desiredNews.ownershipScope
      ) {
        mask.push("ownershipScope");
      }

      if (mask.length > 0) {
        current = yield* billingbudgets.patchBillingAccountsBudgets({
          name: current.name,
          updateMask: mask.join(","),
          body: {
            ...desiredBody,
            etag: current.etag,
          },
        });
      }

      return toAttrs(current, billingAccountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* billingbudgets
        .deleteBillingAccountsBudgets({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "BudgetNotFound"], () => Effect.void),
        );
    }),
  });
