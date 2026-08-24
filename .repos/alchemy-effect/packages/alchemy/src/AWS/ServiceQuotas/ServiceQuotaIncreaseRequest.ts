import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ServiceQuotaIncreaseRequestProps {
  /**
   * Service identifier the quota belongs to, e.g. `"vpc"`, `"lambda"`,
   * `"ec2"`. Discover codes with `servicequotas.listServices`.
   * Changing this replaces the resource.
   */
  serviceCode: string;
  /**
   * Quota identifier, e.g. `"L-F678F1CE"` (VPCs per region).
   * Discover codes with `servicequotas.listServiceQuotas`.
   * Changing this replaces the resource.
   */
  quotaCode: string;
  /**
   * The new quota value to request. Must be greater than the currently
   * applied value. If the applied quota already meets or exceeds this value
   * no request is submitted. Raising it later submits a new request.
   */
  desiredValue: number;
  /**
   * Resource context for resource-level quotas (e.g. an EC2 instance family
   * or an OpenSearch domain ARN). Omit for account-level quotas.
   * Changing this replaces the resource.
   */
  contextId?: string;
  /**
   * Whether AWS may open a support case for the request when it cannot be
   * auto-approved.
   * @default AWS decides (a case is opened when required)
   */
  supportCaseAllowed?: boolean;
}

export interface ServiceQuotaIncreaseRequest extends Resource<
  "AWS.ServiceQuotas.ServiceQuotaIncreaseRequest",
  ServiceQuotaIncreaseRequestProps,
  {
    /**
     * ID of the quota increase request. Undefined when the applied quota
     * already met the desired value and no request was needed.
     */
    requestId: string | undefined;
    /**
     * Request status: `PENDING`, `CASE_OPENED`, `APPROVED`, `DENIED`,
     * `CASE_CLOSED`, `NOT_APPROVED` or `INVALID_REQUEST`. Undefined when no
     * request was needed.
     */
    status: string | undefined;
    /** Support case ID, when the request opened a case. */
    caseId: string | undefined;
    /** Service identifier the quota belongs to. */
    serviceCode: string;
    /** Quota identifier. */
    quotaCode: string;
    /** The requested (desired) quota value. */
    desiredValue: number;
    /**
     * The applied quota value observed at last reconcile (the AWS default
     * value when no account override is applied).
     */
    appliedValue: number | undefined;
    /** ARN of the quota. */
    quotaArn: string | undefined;
    /** Human-readable quota name. */
    quotaName: string | undefined;
    /** Human-readable service name. */
    serviceName: string | undefined;
    /** Unit of measurement of the quota value. */
    unit: string | undefined;
    /** Whether the quota is global (not region-scoped). */
    globalQuota: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Quotas quota increase request at the account or resource level.
 *
 * :::caution
 * Submitting a quota increase request may open an AWS Support case and
 * **cannot be cancelled through the Service Quotas API**. Destroying this
 * resource only forgets the request — a still-open request (and its support
 * case, if any) lives on in AWS.
 * :::
 *
 * The reconciler is idempotent: it first observes the applied quota value
 * and any open request for the quota. A new request is submitted only when
 * the applied value is below `desiredValue` and no open request already
 * asks for it. Raising `desiredValue` later submits a new request.
 *
 * @section Requesting a Quota Increase
 * @example Raise the VPCs-per-region quota
 * ```typescript
 * const increase = yield* ServiceQuotas.ServiceQuotaIncreaseRequest("MoreVpcs", {
 *   serviceCode: "vpc",
 *   quotaCode: "L-F678F1CE",
 *   desiredValue: 10,
 * });
 * ```
 *
 * @example Request without allowing a support case
 * ```typescript
 * const increase = yield* ServiceQuotas.ServiceQuotaIncreaseRequest("MoreFunctions", {
 *   serviceCode: "lambda",
 *   quotaCode: "L-B99A9384",
 *   desiredValue: 2000,
 *   supportCaseAllowed: false,
 * });
 * ```
 */
export const ServiceQuotaIncreaseRequest =
  Resource<ServiceQuotaIncreaseRequest>(
    "AWS.ServiceQuotas.ServiceQuotaIncreaseRequest",
  );

// Statuses in which a request is still in flight and represents the desired
// state (a new submission would be rejected with ResourceAlreadyExists).
const OPEN_STATUSES = ["PENDING", "CASE_OPENED"] as const;

// Read a request by ID; a typed NoSuchResourceException collapses to
// undefined (requests eventually age out of the 90-day history).
const getRequest = (requestId: string) =>
  servicequotas.getRequestedServiceQuotaChange({ RequestId: requestId }).pipe(
    Effect.map((r) => r.RequestedQuota),
    Effect.catchTag("NoSuchResourceException", () => Effect.succeed(undefined)),
  );

// Observe the applied quota value; quotas without an applied (account-level)
// value fall back to the AWS default value.
const observeQuota = (
  serviceCode: string,
  quotaCode: string,
  contextId: string | undefined,
) =>
  servicequotas
    .getServiceQuota({
      ServiceCode: serviceCode,
      QuotaCode: quotaCode,
      ContextId: contextId,
    })
    .pipe(
      Effect.map((r) => r.Quota),
      Effect.catchTag("NoSuchResourceException", () =>
        servicequotas
          .getAWSDefaultServiceQuota({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
          })
          .pipe(
            Effect.map((r) => r.Quota),
            Effect.catchTag("NoSuchResourceException", () =>
              Effect.succeed(undefined),
            ),
          ),
      ),
    );

// Find an open (PENDING / CASE_OPENED) increase request for the quota,
// optionally constrained to an exact desired value.
const findOpenRequest = Effect.fn(function* (
  serviceCode: string,
  quotaCode: string,
  desiredValue?: number,
) {
  for (const status of OPEN_STATUSES) {
    const page = yield* servicequotas
      .listRequestedServiceQuotaChangeHistoryByQuota({
        ServiceCode: serviceCode,
        QuotaCode: quotaCode,
        Status: status,
      })
      .pipe(
        Effect.map((r) => r.RequestedQuotas ?? []),
        Effect.catchTag("NoSuchResourceException", () =>
          Effect.succeed([] as servicequotas.RequestedServiceQuotaChange[]),
        ),
      );
    const match = page.find(
      (r) => desiredValue === undefined || r.DesiredValue === desiredValue,
    );
    if (match !== undefined) return match;
  }
  return undefined;
});

const buildAttrs = (
  identity: { serviceCode: string; quotaCode: string; desiredValue: number },
  request: servicequotas.RequestedServiceQuotaChange | undefined,
  quota: servicequotas.ServiceQuota | undefined,
) => ({
  requestId: request?.Id,
  status: request?.Status,
  caseId: request?.CaseId,
  serviceCode: identity.serviceCode,
  quotaCode: identity.quotaCode,
  desiredValue: request?.DesiredValue ?? identity.desiredValue,
  appliedValue: quota?.Value,
  quotaArn: request?.QuotaArn ?? quota?.QuotaArn,
  quotaName: request?.QuotaName ?? quota?.QuotaName,
  serviceName: request?.ServiceName ?? quota?.ServiceName,
  unit: request?.Unit ?? quota?.Unit,
  globalQuota: request?.GlobalQuota ?? quota?.GlobalQuota,
});

export const ServiceQuotaIncreaseRequestProvider = () =>
  Provider.effect(
    ServiceQuotaIncreaseRequest,
    Effect.gen(function* () {
      return {
        stables: [
          "serviceCode",
          "quotaCode",
          "quotaArn",
          "quotaName",
          "serviceName",
          "unit",
          "globalQuota",
        ],

        // Top-level enumeration: every quota increase request in the
        // account's 90-day request history.
        list: () =>
          servicequotas.listRequestedServiceQuotaChangeHistory.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.RequestedQuotas ?? [])
                .flatMap((request) =>
                  request.Id !== undefined
                    ? [
                        buildAttrs(
                          {
                            serviceCode: request.ServiceCode ?? "",
                            quotaCode: request.QuotaCode ?? "",
                            desiredValue: request.DesiredValue ?? 0,
                          },
                          request,
                          undefined,
                        ),
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ olds, output }) {
          const serviceCode = output?.serviceCode ?? olds?.serviceCode;
          const quotaCode = output?.quotaCode ?? olds?.quotaCode;
          const desiredValue = output?.desiredValue ?? olds?.desiredValue;
          if (serviceCode === undefined || quotaCode === undefined) {
            return undefined;
          }
          const quota = yield* observeQuota(
            serviceCode,
            quotaCode,
            olds?.contextId,
          );
          let request =
            output?.requestId !== undefined
              ? yield* getRequest(output.requestId)
              : undefined;
          if (request === undefined) {
            request = yield* findOpenRequest(
              serviceCode,
              quotaCode,
              desiredValue,
            );
          }
          if (request !== undefined) {
            const attrs = buildAttrs(
              {
                serviceCode,
                quotaCode,
                desiredValue: request.DesiredValue ?? desiredValue ?? 0,
              },
              request,
              quota,
            );
            // Requests are not taggable, so ownership cannot be verified
            // from cloud state alone. An open request discovered without
            // prior state is gated behind --adopt.
            return output !== undefined ? attrs : Unowned(attrs);
          }
          // No request on record. When WE previously reconciled this
          // resource (output present) and the applied quota still satisfies
          // the desired value, the resource is intact. Without prior state
          // a merely-satisfied quota is NOT a pre-existing foreign resource
          // (there is nothing to adopt) — report it as missing.
          if (
            output !== undefined &&
            desiredValue !== undefined &&
            quota?.Value !== undefined &&
            quota.Value >= desiredValue
          ) {
            return buildAttrs(
              { serviceCode, quotaCode, desiredValue },
              undefined,
              quota,
            );
          }
          return undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.serviceCode !== olds.serviceCode ||
            news.quotaCode !== olds.quotaCode ||
            news.contextId !== olds.contextId
          ) {
            return { action: "replace" } as const;
          }
          // desiredValue / supportCaseAllowed changes fall through to the
          // default update path — reconcile submits a new request if needed.
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const { serviceCode, quotaCode, desiredValue } = news;

          // 1. OBSERVE — the applied quota value and any existing request.
          //    Cloud state is authoritative; output only caches the request
          //    ID from a previous run.
          const quota = yield* observeQuota(
            serviceCode,
            quotaCode,
            news.contextId,
          );
          let request =
            output?.requestId !== undefined
              ? yield* getRequest(output.requestId)
              : undefined;
          if (
            request !== undefined &&
            (request.ServiceCode !== serviceCode ||
              request.QuotaCode !== quotaCode ||
              request.DesiredValue !== desiredValue)
          ) {
            // The cached request no longer reflects the desired state.
            request = undefined;
          }
          if (request === undefined) {
            request = yield* findOpenRequest(
              serviceCode,
              quotaCode,
              desiredValue,
            );
          }

          // 2. ENSURE — submit only when the applied value is below the
          //    desired value and no matching request is already in flight.
          if (request === undefined) {
            const satisfied =
              quota?.Value !== undefined && quota.Value >= desiredValue;
            if (!satisfied) {
              request = yield* servicequotas
                .requestServiceQuotaIncrease({
                  ServiceCode: serviceCode,
                  QuotaCode: quotaCode,
                  DesiredValue: desiredValue,
                  ContextId: news.contextId,
                  SupportCaseAllowed: news.supportCaseAllowed,
                })
                .pipe(
                  Effect.map((r) => r.RequestedQuota),
                  // An open request for this quota already exists (created
                  // out-of-band, or a race with a prior partial run) —
                  // converge on it instead of failing.
                  Effect.catchTag("ResourceAlreadyExistsException", () =>
                    findOpenRequest(serviceCode, quotaCode),
                  ),
                );
            }
          }

          // 3. A submitted request is immutable — nothing further to sync.
          if (request?.Id !== undefined) {
            yield* session.note(request.Id);
          }
          return buildAttrs(
            { serviceCode, quotaCode, desiredValue },
            request,
            quota,
          );
        }),

        delete: Effect.fn(function* ({ output }) {
          // Service Quotas offers no API to cancel a submitted quota
          // increase request. Deleting the resource only forgets it; a
          // still-open request (and its support case) remains in AWS.
          if (
            output.requestId !== undefined &&
            (output.status === "PENDING" || output.status === "CASE_OPENED")
          ) {
            yield* Effect.logWarning(
              `Quota increase request ${output.requestId} for ${output.serviceCode}/${output.quotaCode} is still open and cannot be cancelled via the Service Quotas API; it remains in AWS.`,
            );
          }
        }),
      };
    }),
  );
