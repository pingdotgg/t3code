import {
  type CodexSettings,
  ProviderDriverKind,
  type ProviderBankedReset,
  type ProviderQuotaMetric,
  type ProviderQuotaSnapshot,
  type ProviderInstanceId,
  PROVIDER_QUOTA_DISPLAY_TEXT_MAX_LENGTH,
  PROVIDER_QUOTA_IDENTIFIER_MAX_LENGTH,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  ProviderQuotaAdapterError,
  remainingPercentFromUsed,
  resolveHeadlineMetricKey,
  truncateProviderQuotaDisplayText,
  truncateProviderQuotaIdentifier,
  truncateProviderQuotaLongText,
  type ProviderQuotaCapability,
} from "../ProviderQuota.ts";
import {
  makeScopedCodexAppServerClient,
  type ScopedCodexAppServerClientInput,
} from "../Layers/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../Layers/codexLaunchArgs.ts";

const DRIVER = ProviderDriverKind.make("codex");
const CACHE_TTL = "30 seconds" as const;
const DETAIL_VALUE_MAX_LENGTH = 160;

type CodexQuotaClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

export interface CodexProviderQuotaOptions {
  /** Narrow injection seam for typed client boundary tests. */
  readonly openClient?: Effect.Effect<
    CodexQuotaClient,
    CodexErrors.CodexAppServerError,
    Scope.Scope
  >;
}

export interface CodexProviderQuotaCapability extends ProviderQuotaCapability {
  readonly onRateLimitsUpdated: (
    update: CodexSchema.V2AccountRateLimitsUpdatedNotification,
  ) => Effect.Effect<void>;
}

const unixSecondsToIso = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return Option.match(DateTime.make(value * 1_000), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
};

const nonNegativeWindowMinutes = (value: number | null | undefined): number | null =>
  value !== null && value !== undefined && value >= 0 ? value : null;

const windowLabel = (name: string, windowDurationMins: number | null | undefined): string =>
  truncateProviderQuotaDisplayText(
    windowDurationMins !== null && windowDurationMins !== undefined && windowDurationMins >= 0
      ? `${name} (${windowDurationMins} min)`
      : name,
  );

const rateLimitWindowMetric = (
  key: string,
  label: string,
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow,
): ProviderQuotaMetric => ({
  key: truncateProviderQuotaIdentifier(key),
  label: windowLabel(label, window.windowDurationMins),
  remainingPercent: remainingPercentFromUsed(window.usedPercent),
  usedPercent: window.usedPercent,
  resetsAt: unixSecondsToIso(window.resetsAt),
  windowMinutes: nonNegativeWindowMinutes(window.windowDurationMins),
  blocking: true,
});

const individualLimitMetric = (
  key: string,
  label: string,
  limit: CodexSchema.V2GetAccountRateLimitsResponse__SpendControlLimitSnapshot,
): ProviderQuotaMetric => ({
  key: truncateProviderQuotaIdentifier(key),
  label: truncateProviderQuotaDisplayText(label),
  remainingPercent: limit.remainingPercent,
  usedPercent: null,
  resetsAt: unixSecondsToIso(limit.resetsAt),
  windowMinutes: null,
  blocking: true,
});

const appendRateLimitMetrics = (
  metrics: Array<ProviderQuotaMetric>,
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"],
  options: {
    readonly keyPrefix: string;
    readonly primaryLabel: string;
    readonly secondaryLabel: string;
    readonly individualLabel: string;
  },
): void => {
  if (rateLimits.primary) {
    metrics.push(
      rateLimitWindowMetric(
        `${options.keyPrefix}primary`,
        options.primaryLabel,
        rateLimits.primary,
      ),
    );
  }
  if (rateLimits.secondary) {
    metrics.push(
      rateLimitWindowMetric(
        `${options.keyPrefix}secondary`,
        options.secondaryLabel,
        rateLimits.secondary,
      ),
    );
  }
  if (rateLimits.individualLimit) {
    metrics.push(
      individualLimitMetric(
        `${options.keyPrefix}${options.keyPrefix ? "individual" : "individualLimit"}`,
        options.individualLabel,
        rateLimits.individualLimit,
      ),
    );
  }
};

const trimmedNullable = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const boundedNullableDisplayText = (value: string | null | undefined): string | null => {
  const trimmed = trimmedNullable(value);
  return trimmed === null ? null : truncateProviderQuotaDisplayText(trimmed);
};

const boundedNullableLongText = (value: string | null | undefined): string | null => {
  const trimmed = trimmedNullable(value);
  return trimmed === null ? null : truncateProviderQuotaLongText(trimmed);
};

const normalizeBankedReset = (
  reset: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCredit,
): ProviderBankedReset | null => {
  const id = reset.id.trim();
  const grantedAt = unixSecondsToIso(reset.grantedAt);
  if (id.length === 0 || grantedAt === null) return null;
  return {
    id: truncateProviderQuotaIdentifier(id),
    title: boundedNullableDisplayText(reset.title),
    description: boundedNullableLongText(reset.description),
    grantedAt,
    expiresAt: unixSecondsToIso(reset.expiresAt),
    resetType: truncateProviderQuotaIdentifier(reset.resetType),
    status: reset.status,
  };
};

const boundedDetail = (
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"],
): Readonly<Record<string, string>> => {
  const detail: Record<string, string> = {};
  const add = (key: string, value: string | boolean | null | undefined): void => {
    if (value === null || value === undefined) return;
    const normalized = String(value).trim().slice(0, DETAIL_VALUE_MAX_LENGTH);
    if (normalized.length > 0) detail[key] = normalized;
  };
  add("limitId", rateLimits.limitId);
  add("limitName", rateLimits.limitName);
  add("planType", rateLimits.planType);
  add("rateLimitReachedType", rateLimits.rateLimitReachedType);
  add("spendControlReached", rateLimits.spendControlReached);
  return detail;
};

export const normalizeCodexProviderQuota = (
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  instanceId: ProviderInstanceId,
  readAt: string,
): ProviderQuotaSnapshot => {
  const metrics: Array<ProviderQuotaMetric> = [];
  appendRateLimitMetrics(metrics, response.rateLimits, {
    keyPrefix: "",
    primaryLabel: "Primary",
    secondaryLabel: "Secondary",
    individualLabel: "Individual limit",
  });

  for (const [limitId, rateLimits] of Object.entries(response.rateLimitsByLimitId ?? {})) {
    const name = boundedNullableDisplayText(rateLimits.limitName) ?? "Limit";
    const boundedLimitId = truncateProviderQuotaIdentifier(limitId).slice(
      0,
      PROVIDER_QUOTA_IDENTIFIER_MAX_LENGTH - "limit::individual".length,
    );
    appendRateLimitMetrics(metrics, rateLimits, {
      keyPrefix: `limit:${boundedLimitId}:`,
      primaryLabel: `${name} primary`,
      secondaryLabel: `${name} secondary`,
      individualLabel: `${name} individual limit`,
    });
  }

  const resetSummary = response.rateLimitResetCredits;
  const resets = (resetSummary?.credits ?? [])
    .map(normalizeBankedReset)
    .filter((reset): reset is ProviderBankedReset => reset !== null);
  const availableCount = Math.max(0, resetSummary?.availableCount ?? 0);

  return {
    instanceId,
    driver: DRIVER,
    status: "current",
    source: "codex-app-server",
    readAt,
    lastSuccessfulReadAt: readAt,
    headlineMetricKey: resolveHeadlineMetricKey(metrics),
    metrics,
    credits: response.rateLimits.credits
      ? {
          hasCredits: response.rateLimits.credits.hasCredits,
          unlimited: response.rateLimits.credits.unlimited,
          balance:
            response.rateLimits.credits.balance === null ||
            response.rateLimits.credits.balance === undefined
              ? null
              : response.rateLimits.credits.balance.slice(
                  0,
                  PROVIDER_QUOTA_DISPLAY_TEXT_MAX_LENGTH,
                ),
        }
      : null,
    bankedResets: resetSummary
      ? {
          availableCount,
          resets,
          detailsComplete:
            resetSummary.credits !== null &&
            resetSummary.credits !== undefined &&
            resets.length === availableCount,
        }
      : null,
    detail: boundedDetail(response.rateLimits),
    message: null,
  };
};

const quotaRequestError = (
  cause: CodexErrors.CodexAppServerError | ProviderQuotaAdapterError,
): ProviderQuotaAdapterError => {
  if (cause._tag === "ProviderQuotaAdapterError") return cause;
  if (cause._tag === "CodexAppServerRequestError" && cause.code === -32601) {
    return new ProviderQuotaAdapterError({
      reason: "unsupported",
      detail: "This Codex version does not expose provider quota.",
      cause,
    });
  }
  return new ProviderQuotaAdapterError({
    reason: "providerFailed",
    detail: "Codex quota request failed.",
    cause,
  });
};

const requireAuthenticatedAccount = (
  account: CodexSchema.V2GetAccountResponse,
): Effect.Effect<void, ProviderQuotaAdapterError> =>
  account.requiresOpenaiAuth && (account.account === null || account.account === undefined)
    ? Effect.fail(
        new ProviderQuotaAdapterError({
          reason: "authRequired",
          detail: "Sign in to Codex to view quota information.",
        }),
      )
    : Effect.void;

export const makeCodexProviderQuota = Effect.fn("makeCodexProviderQuota")(function* (
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
  instanceId: ProviderInstanceId,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: CodexProviderQuotaOptions = {},
): Effect.fn.Return<CodexProviderQuotaCapability> {
  const clientInput: ScopedCodexAppServerClientInput = {
    binaryPath: config.binaryPath,
    launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
    cwd: process.cwd(),
    environment,
    ...(config.homePath ? { homePath: config.homePath } : {}),
  };
  const openClient =
    options.openClient ??
    makeScopedCodexAppServerClient(clientInput).pipe(
      Effect.map(({ client }) => client),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const readUncached = Effect.scoped(
    openClient.pipe(
      Effect.flatMap((client) =>
        client
          .request("account/read", {})
          .pipe(
            Effect.flatMap(requireAuthenticatedAccount),
            Effect.andThen(client.request("account/rateLimits/read", undefined)),
          ),
      ),
      Effect.flatMap((response) =>
        Effect.map(DateTime.now, (now) =>
          normalizeCodexProviderQuota(response, instanceId, DateTime.formatIso(now)),
        ),
      ),
    ),
  ).pipe(Effect.mapError(quotaRequestError));
  const [read, invalidate] = yield* Effect.cachedInvalidateWithTTL(readUncached, CACHE_TTL);
  const revisionRef = yield* Ref.make(0);

  const consumeBankedReset: NonNullable<ProviderQuotaCapability["consumeBankedReset"]> = Effect.fn(
    "CodexProviderQuota.consumeBankedReset",
  )(function* (input) {
    const response = yield* Effect.scoped(
      openClient.pipe(
        Effect.flatMap((client) =>
          client.request("account/read", {}).pipe(
            Effect.flatMap(requireAuthenticatedAccount),
            Effect.andThen(
              client.request("account/rateLimitResetCredit/consume", {
                creditId: input.creditId,
                idempotencyKey: input.idempotencyKey,
              }),
            ),
          ),
        ),
      ),
    ).pipe(Effect.mapError(quotaRequestError));
    return response.outcome;
  });

  const onRateLimitsUpdated = Effect.fn("CodexProviderQuota.onRateLimitsUpdated")(function* (
    _update: CodexSchema.V2AccountRateLimitsUpdatedNotification,
  ) {
    yield* invalidate;
    yield* Ref.update(revisionRef, (revision) => revision + 1);
  });

  return {
    read,
    revision: Ref.get(revisionRef),
    consumeBankedReset,
    onRateLimitsUpdated,
  };
});
