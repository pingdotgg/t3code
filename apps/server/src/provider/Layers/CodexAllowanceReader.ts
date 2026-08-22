import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SubscriptionAllowance,
  type SubscriptionAllowanceWindow,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderAllowanceReader } from "../Services/ProviderAllowanceReader.ts";
import { ProviderAllowanceReadError } from "../Services/ProviderAllowanceReader.ts";
import { withCodexAppServerClient, type CodexAppServerClientInput } from "./CodexProvider.ts";

const CODEX_ALLOWANCE_READ_TIMEOUT = "10 seconds" as const;

const mapNativeEpochSeconds = (value: number | null): string | null =>
  value === null ? null : DateTime.formatIso(DateTime.makeUnsafe(value * 1_000));

const mapWindow = (
  scope: SubscriptionAllowanceWindow["scope"],
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): SubscriptionAllowanceWindow | undefined => {
  if (window === null || window === undefined) return undefined;

  return {
    scope,
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: mapNativeEpochSeconds(window.resetsAt) }),
  };
};

const mapSparseWindow = (
  scope: SubscriptionAllowanceWindow["scope"],
  window: CodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitWindow | null | undefined,
): SubscriptionAllowanceWindow | undefined => {
  if (window === null || window === undefined) return undefined;

  return {
    scope,
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins === undefined || window.windowDurationMins === null
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    ...(window.resetsAt === undefined || window.resetsAt === null
      ? {}
      : { resetsAt: mapNativeEpochSeconds(window.resetsAt) }),
  };
};

export function mapCodexRateLimits(input: {
  readonly instanceId: ProviderInstanceId;
  readonly response: CodexSchema.V2GetAccountRateLimitsResponse;
}): SubscriptionAllowance {
  const rateLimits = input.response.rateLimits;
  const windows = [
    mapWindow("primary", rateLimits.primary),
    mapWindow("secondary", rateLimits.secondary),
  ].filter((window): window is SubscriptionAllowanceWindow => window !== undefined);

  const credits =
    rateLimits.credits === null || rateLimits.credits === undefined
      ? undefined
      : {
          ...(rateLimits.credits.balance === undefined
            ? {}
            : { balance: rateLimits.credits.balance }),
          hasCredits: rateLimits.credits.hasCredits,
          unlimited: rateLimits.credits.unlimited,
        };

  const individualLimit = rateLimits.individualLimit;
  const hasReachedState =
    rateLimits.spendControlReached !== undefined && rateLimits.spendControlReached !== null;
  const spendingControl =
    (individualLimit !== null && individualLimit !== undefined) || hasReachedState
      ? {
          ...(rateLimits.spendControlReached === undefined
            ? {}
            : { reached: rateLimits.spendControlReached }),
          ...(individualLimit === null || individualLimit === undefined
            ? {}
            : {
                limit: individualLimit.limit,
                remainingPercent: individualLimit.remainingPercent,
                resetsAt: DateTime.formatIso(DateTime.makeUnsafe(individualLimit.resetsAt * 1_000)),
                used: individualLimit.used,
              }),
        }
      : undefined;

  const hasProviderData =
    windows.length > 0 || credits !== undefined || spendingControl !== undefined;

  return {
    provider: "codex",
    instanceId: input.instanceId,
    status: hasProviderData ? "available" : "unavailable",
    windows,
    ...(credits === undefined ? {} : { credits }),
    ...(spendingControl === undefined ? {} : { spendingControl }),
    ...(hasProviderData ? {} : { message: "Codex did not provide subscription usage limits." }),
  } satisfies SubscriptionAllowance;
}

const isCodexRateLimitSnapshot = Schema.is(
  CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
);

export function mapCodexRateLimitsUpdate(input: {
  readonly instanceId: ProviderInstanceId;
  readonly event: ProviderRuntimeEvent;
}): SubscriptionAllowance | undefined {
  const { event } = input;
  if (event.provider !== "codex" || event.type !== "account.rate-limits.updated") {
    return undefined;
  }
  const rateLimits = event.payload.rateLimits;
  if (!isCodexRateLimitSnapshot(rateLimits)) return undefined;

  const windows = [
    mapSparseWindow("primary", rateLimits.primary),
    mapSparseWindow("secondary", rateLimits.secondary),
  ].filter((window): window is SubscriptionAllowanceWindow => window !== undefined);
  const credits =
    rateLimits.credits === null || rateLimits.credits === undefined
      ? undefined
      : {
          ...(rateLimits.credits.balance === undefined || rateLimits.credits.balance === null
            ? {}
            : { balance: rateLimits.credits.balance }),
          hasCredits: rateLimits.credits.hasCredits,
          unlimited: rateLimits.credits.unlimited,
        };
  const hasReachedState =
    rateLimits.spendControlReached !== undefined && rateLimits.spendControlReached !== null;
  const individualLimit = rateLimits.individualLimit;
  const spendingControl =
    individualLimit !== undefined && individualLimit !== null
      ? {
          ...(hasReachedState ? { reached: rateLimits.spendControlReached } : {}),
          limit: individualLimit.limit,
          remainingPercent: individualLimit.remainingPercent,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(individualLimit.resetsAt * 1_000)),
          used: individualLimit.used,
        }
      : hasReachedState
        ? { reached: rateLimits.spendControlReached }
        : undefined;

  if (windows.length === 0 && credits === undefined && spendingControl === undefined) {
    return undefined;
  }

  return {
    provider: "codex",
    instanceId: input.instanceId,
    status: "available",
    windows,
    ...(credits === undefined ? {} : { credits }),
    ...(spendingControl === undefined ? {} : { spendingControl }),
  } satisfies SubscriptionAllowance;
}

export interface CodexAllowanceReaderInput extends CodexAppServerClientInput {
  readonly instanceId: ProviderInstanceId;
}

export const makeCodexAllowanceReader = Effect.fn("makeCodexAllowanceReader")(function* (
  input: CodexAllowanceReaderInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const read = withCodexAppServerClient(input, ({ client }) =>
    client
      .request("account/rateLimits/read", undefined)
      .pipe(
        Effect.map((response) => mapCodexRateLimits({ instanceId: input.instanceId, response })),
      ),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAllowanceReadError({
          provider: "codex",
          instanceId: input.instanceId,
          operation: "read",
          cause,
        }),
    ),
    Effect.timeout(CODEX_ALLOWANCE_READ_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new ProviderAllowanceReadError({
            provider: "codex",
            instanceId: input.instanceId,
            operation: "timeout",
            cause,
          }),
        ),
    }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.scoped,
  );

  return {
    provider: "codex",
    read,
    update: (event) => mapCodexRateLimitsUpdate({ instanceId: input.instanceId, event }),
  } satisfies ProviderAllowanceReader;
});
