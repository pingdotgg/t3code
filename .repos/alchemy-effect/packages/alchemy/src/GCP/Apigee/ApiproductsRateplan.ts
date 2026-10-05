import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  sameJson,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type Money = {
  /** ISO 4217 currency code. */
  currencyCode?: string;
  /** Whole units of the amount. */
  units?: string;
  /** Nano (10^-9) units of the amount. */
  nanos?: number;
};

export type ApiproductsRateplanProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Parent API product id or
   * `organizations/{org}/apiproducts/{product}`. Immutable.
   */
  apiproduct: string;
  /**
   * Display name of the rate plan. If omitted, a unique name is
   * generated.
   */
  displayName?: string;
  /**
   * Human-readable description shown to portal developers.
   */
  description?: string;
  /**
   * Billing frequency (`WEEKLY` or `MONTHLY`).
   */
  billingPeriod?:
    | apigee.GoogleCloudApigeeV1RatePlanBillingPeriodEnum
    | (string & {});
  /**
   * ISO 4217 currency code used for billing.
   */
  currencyCode?: string;
  /**
   * Rate plan state (`DRAFT` or `PUBLISHED`).
   * @default "DRAFT"
   */
  state?: apigee.GoogleCloudApigeeV1RatePlanStateEnum | (string & {});
  /**
   * Consumption pricing model.
   */
  consumptionPricingType?:
    | apigee.GoogleCloudApigeeV1RatePlanConsumptionPricingTypeEnum
    | (string & {});
  /**
   * Revenue share model.
   */
  revenueShareType?:
    | apigee.GoogleCloudApigeeV1RatePlanRevenueShareTypeEnum
    | (string & {});
  /**
   * Time the plan becomes active, milliseconds since epoch.
   */
  startTime?: string;
  /**
   * Time the plan expires, milliseconds since epoch. `0` never expires.
   */
  endTime?: string;
  /**
   * One-time setup fee.
   */
  setupFee?: Money;
  /**
   * Fixed recurring fee billed in advance.
   */
  fixedRecurringFee?: Money;
  /**
   * Frequency at which the fixed fee is charged.
   */
  fixedFeeFrequency?: number;
};

export type ApiproductsRateplan = Resource<
  "GCP.Apigee.ApiproductsRateplan",
  ApiproductsRateplanProps,
  {
    /** Full resource name `organizations/{org}/apiproducts/{product}/rateplans/{id}`. */
    name: string;
    /** Server-assigned rate plan id. */
    rateplanId: string;
    /** Parent API product id. */
    apiproductId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Billing period. */
    billingPeriod: string | undefined;
    /** Currency code. */
    currencyCode: string | undefined;
    /** Rate plan state. */
    state: string | undefined;
    /** Consumption pricing type. */
    consumptionPricingType: string | undefined;
    /** Revenue share type. */
    revenueShareType: string | undefined;
    /** Start time in milliseconds since epoch. */
    startTime: string | undefined;
    /** End time in milliseconds since epoch. */
    endTime: string | undefined;
    /** Setup fee. */
    setupFee: Money | undefined;
    /** Fixed recurring fee. */
    fixedRecurringFee: Money | undefined;
    /** Fixed fee frequency. */
    fixedFeeFrequency: number | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee rate plan attached to an API product for monetization.
 *
 * Rate plans have no labels field and their text is shown to portal
 * developers, so Alchemy tracks a plan only by the server-assigned id in
 * its state; nuke cannot discover plans. Only one plan per product can be `PUBLISHED`.
 *
 * ### Creating a Rate Plan
 * **Example:** Draft monthly plan
 * ```typescript
 * const plan = yield* GCP.Apigee.ApiproductsRateplan("Standard", {
 *   apiproduct: product.apiproductId,
 *   displayName: "Standard",
 *   billingPeriod: "MONTHLY",
 *   currencyCode: "USD",
 *   state: "DRAFT",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const ApiproductsRateplan = Resource<ApiproductsRateplan>(
  "GCP.Apigee.ApiproductsRateplan",
);

export class ApiproductsRateplanNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApiproductsRateplanNotResolved",
)<{
  name: string;
}> {}

const productParent = (organizationId: string, apiproduct: string) => {
  const id = lastSegment(apiproduct);
  return `${orgParent(organizationId)}/apiproducts/${id}`;
};

const toAttrs = (
  plan: apigee.GoogleCloudApigeeV1RatePlan,
  project: string,
  organizationId: string,
) => {
  const name = plan.name ?? "";
  return {
    name,
    rateplanId: lastSegment(name),
    apiproductId: lastSegment(plan.apiproduct ?? ""),
    organizationId,
    project,
    displayName: plan.displayName,
    description: plan.description,
    billingPeriod: plan.billingPeriod,
    currencyCode: plan.currencyCode,
    state: plan.state,
    consumptionPricingType: plan.consumptionPricingType,
    revenueShareType: plan.revenueShareType,
    startTime: plan.startTime,
    endTime: plan.endTime,
    setupFee: plan.setupFee,
    fixedRecurringFee: plan.fixedRecurringFee,
    fixedFeeFrequency: plan.fixedFeeFrequency,
    createdAt: plan.createdAt,
    lastModifiedAt: plan.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsApiproductsRateplans({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const ApiproductsRateplanProvider = () =>
  Provider.succeed(ApiproductsRateplan, {
    stables: [
      "name",
      "rateplanId",
      "apiproductId",
      "organizationId",
      "project",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      const previousProduct = olds?.apiproduct
        ? lastSegment(olds.apiproduct)
        : output?.apiproductId;
      const nextProduct = lastSegment(news.apiproduct);
      if (
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg) ||
        (previousProduct !== undefined && nextProduct !== previousProduct)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const name = output?.name;
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, organizationId);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const parent = productParent(organizationId, news.apiproduct);
      const generated = yield* toPhysicalId(
        id,
        news.displayName,
        output?.displayName,
        MAX_NAME_LENGTH,
      );
      const desiredDescription = news.description;
      const body: apigee.GoogleCloudApigeeV1RatePlan = {
        displayName: generated,
        description: desiredDescription,
        billingPeriod: news.billingPeriod,
        currencyCode: news.currencyCode,
        state: news.state ?? "DRAFT",
        consumptionPricingType: news.consumptionPricingType,
        revenueShareType: news.revenueShareType,
        startTime: news.startTime,
        endTime: news.endTime,
        setupFee: news.setupFee,
        fixedRecurringFee: news.fixedRecurringFee,
        fixedFeeFrequency: news.fixedFeeFrequency,
      };

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsApiproductsRateplans({
            parent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ApiproductsRateplanNotResolved({
          name: output?.name ?? parent,
        });
      }

      const needsUpdate =
        (current.displayName ?? "") !== (body.displayName ?? "") ||
        (current.description ?? "") !== (desiredDescription ?? "") ||
        (current.billingPeriod ?? "") !== (news.billingPeriod ?? "") ||
        (current.currencyCode ?? "") !== (news.currencyCode ?? "") ||
        (current.state ?? "") !== (body.state ?? "") ||
        (current.consumptionPricingType ?? "") !==
          (news.consumptionPricingType ?? "") ||
        (current.revenueShareType ?? "") !== (news.revenueShareType ?? "") ||
        (current.startTime ?? "") !== (news.startTime ?? "") ||
        (current.endTime ?? "") !== (news.endTime ?? "") ||
        (current.fixedFeeFrequency ?? 0) !== (news.fixedFeeFrequency ?? 0) ||
        !sameJson(current.setupFee ?? {}, news.setupFee ?? {}) ||
        !sameJson(
          current.fixedRecurringFee ?? {},
          news.fixedRecurringFee ?? {},
        );

      if (needsUpdate) {
        current = yield* apigee.updateOrganizationsApiproductsRateplans({
          name: current.name,
          body,
        });
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsApiproductsRateplans({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
