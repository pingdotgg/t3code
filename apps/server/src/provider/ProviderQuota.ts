/**
 * Per-instance provider quota capability and safe snapshot fallbacks.
 *
 * Driver-specific quota protocols stay behind the captured capability. This
 * module only defines the normalized data boundary shared with the summary
 * service.
 *
 * @module provider/ProviderQuota
 */
import {
  type ProviderQuotaConsumeResetInput,
  type ProviderQuotaConsumeResetOutcome,
  type ProviderQuotaMetric,
  type ProviderQuotaSnapshot,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ProviderInstance } from "./ProviderDriver.ts";

export const ProviderQuotaPublicMessage = {
  unavailable: "Quota information is unavailable for this provider.",
  authRequired: "Sign in to the provider to view quota information.",
  refreshFailed: "Quota information could not be refreshed.",
} as const;
export type ProviderQuotaPublicMessage =
  (typeof ProviderQuotaPublicMessage)[keyof typeof ProviderQuotaPublicMessage];

type ProviderQuotaInstance = Pick<ProviderInstance, "instanceId" | "driverKind">;

export class ProviderQuotaAdapterError extends Schema.TaggedErrorClass<ProviderQuotaAdapterError>()(
  "ProviderQuotaAdapterError",
  {
    reason: Schema.Literals(["authRequired", "timeout", "unsupported", "providerFailed"]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Captured per-instance quota operations. */
export interface ProviderQuotaCapability {
  readonly read: Effect.Effect<ProviderQuotaSnapshot, ProviderQuotaAdapterError>;
  /** Monotonic per-instance generation; provider events increment it to bypass cached reads. */
  readonly revision: Effect.Effect<number>;
  readonly consumeBankedReset?: (
    input: Pick<ProviderQuotaConsumeResetInput, "creditId" | "idempotencyKey">,
  ) => Effect.Effect<ProviderQuotaConsumeResetOutcome, ProviderQuotaAdapterError>;
}

const publicMessageForReason = (reason: ProviderQuotaAdapterError["reason"]): string => {
  switch (reason) {
    case "authRequired":
      return ProviderQuotaPublicMessage.authRequired;
    case "unsupported":
      return ProviderQuotaPublicMessage.unavailable;
    case "timeout":
    case "providerFailed":
      return ProviderQuotaPublicMessage.refreshFailed;
  }
};

const isProviderQuotaPublicMessage = (message: unknown): message is ProviderQuotaPublicMessage =>
  Predicate.isString(message) &&
  Object.values(ProviderQuotaPublicMessage).includes(message as ProviderQuotaPublicMessage);

/** Convert provider-reported usage into remaining capacity without rounding it. */
export const remainingPercentFromUsed = (usedPercent: number): number =>
  Math.min(100, Math.max(0, 100 - usedPercent));

/** Select the limiting quota window. Credits and spend-only metrics cannot be headlines. */
export const resolveHeadlineMetricKey = (
  metrics: ReadonlyArray<ProviderQuotaMetric>,
): ProviderQuotaMetric["key"] | null => {
  let headline: ProviderQuotaMetric | undefined;

  for (const metric of metrics) {
    if (
      metric.blocking &&
      metric.remainingPercent !== null &&
      Number.isFinite(metric.remainingPercent) &&
      (headline === undefined || metric.remainingPercent < (headline.remainingPercent ?? Infinity))
    ) {
      headline = metric;
    }
  }

  return headline?.key ?? null;
};

/** Create the honest fallback for drivers that do not expose quota data. */
export const unknownProviderQuotaSnapshot = (
  instance: ProviderQuotaInstance,
  readAt: string,
  message?: ProviderQuotaPublicMessage,
): ProviderQuotaSnapshot => ({
  instanceId: instance.instanceId,
  driver: instance.driverKind,
  status: "unknown",
  source: "unsupported",
  readAt,
  lastSuccessfulReadAt: null,
  headlineMetricKey: null,
  metrics: [],
  credits: null,
  bankedResets: null,
  detail: {},
  message: isProviderQuotaPublicMessage(message) ? message : ProviderQuotaPublicMessage.unavailable,
});

const hasSuccessfulQuotaData = (
  snapshot: ProviderQuotaSnapshot,
): snapshot is ProviderQuotaSnapshot & { readonly lastSuccessfulReadAt: string } =>
  snapshot.lastSuccessfulReadAt !== null;

/**
 * Reduce an adapter failure to a safe wire snapshot. A prior successful
 * snapshot remains useful, but is explicitly marked stale and never carries
 * the adapter's raw error or cause.
 */
export const errorProviderQuotaSnapshot = (
  instance: ProviderQuotaInstance,
  readAt: string,
  error: ProviderQuotaAdapterError,
  previous?: ProviderQuotaSnapshot,
): ProviderQuotaSnapshot => {
  const failure = {
    detail: { reason: error.reason },
    message: publicMessageForReason(error.reason),
  };

  if (previous && hasSuccessfulQuotaData(previous)) {
    return {
      ...previous,
      instanceId: instance.instanceId,
      driver: instance.driverKind,
      status: "stale",
      readAt,
      ...failure,
    };
  }

  return {
    instanceId: instance.instanceId,
    driver: instance.driverKind,
    status: error.reason === "authRequired" ? "authRequired" : "error",
    source: "adapter",
    readAt,
    lastSuccessfulReadAt: null,
    headlineMetricKey: null,
    metrics: [],
    credits: null,
    bankedResets: null,
    ...failure,
  };
};
