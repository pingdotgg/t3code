import * as controltower from "@distilled.cloud/aws/controltower";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalParameters,
  observeControlTowerTags,
  syncControlTowerTags,
} from "./internal.ts";

export interface EnabledBaselineProps {
  /**
   * The ARN of the baseline to enable, e.g. the `AWSControlTowerBaseline`
   * ARN from `ListBaselines`. Changing the baseline replaces the
   * enablement.
   */
  baselineIdentifier: string;
  /**
   * The baseline version to enable, e.g. `"4.0"`. Updated in place via
   * `UpdateEnabledBaseline`.
   */
  baselineVersion: string;
  /**
   * The ARN of the target (organizational unit) the baseline is enabled
   * on. Changing the target replaces the enablement.
   */
  targetIdentifier: string;
  /**
   * Parameters applied to the baseline, as `{ key, value }` pairs — e.g.
   * `IdentityCenterEnabledBaselineArn` for the `AWSControlTowerBaseline`.
   * Updated in place via `UpdateEnabledBaseline`.
   */
  parameters?: { key: string; value: any }[];
  /**
   * Tags to apply to the enabled baseline. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface EnabledBaseline extends Resource<
  "AWS.ControlTower.EnabledBaseline",
  EnabledBaselineProps,
  {
    /**
     * The ARN of the enabled baseline (the `EnabledBaseline` resource).
     */
    enabledBaselineArn: string;
    /**
     * The ARN of the baseline that was enabled.
     */
    baselineIdentifier: string;
    /**
     * The ARN of the target organizational unit.
     */
    targetIdentifier: string;
    /**
     * The enabled baseline version.
     */
    baselineVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Control Tower baseline enabled on a target organizational unit.
 * Enabling a baseline (e.g. `AWSControlTowerBaseline`) starts an
 * asynchronous operation that registers the OU with Control Tower and
 * deploys the baseline's governance resources to its accounts.
 *
 * Requires an AWS Control Tower landing zone and can only be managed from
 * the Organizations management account.
 * @resource
 * @section Enabling Baselines
 * @example Register an OU with Control Tower
 * ```typescript
 * import * as ControlTower from "alchemy/AWS/ControlTower";
 *
 * const enabled = yield* ControlTower.EnabledBaseline("WorkloadsBaseline", {
 *   baselineIdentifier:
 *     "arn:aws:controltower:us-west-2::baseline/17BSJV3IGJ2QSGA2",
 *   baselineVersion: "4.0",
 *   targetIdentifier: "arn:aws:organizations::111122223333:ou/o-example/ou-example",
 * });
 * ```
 *
 * @example Baseline with Identity Center parameter
 * ```typescript
 * const enabled = yield* ControlTower.EnabledBaseline("WorkloadsBaseline", {
 *   baselineIdentifier: controlTowerBaselineArn,
 *   baselineVersion: "4.0",
 *   targetIdentifier: ouArn,
 *   parameters: [
 *     {
 *       key: "IdentityCenterEnabledBaselineArn",
 *       value: identityCenterEnabledBaselineArn,
 *     },
 *   ],
 * });
 * ```
 */
export const EnabledBaseline = Resource<EnabledBaseline>(
  "AWS.ControlTower.EnabledBaseline",
);

/**
 * An asynchronous baseline operation (ENABLE_BASELINE / DISABLE_BASELINE /
 * UPDATE_ENABLED_BASELINE) converged to the terminal `FAILED` status.
 */
export class BaselineOperationFailed extends Data.TaggedError(
  "BaselineOperationFailed",
)<{
  readonly operationIdentifier: string;
  readonly status: string;
  readonly statusMessage: string | undefined;
}> {}

/**
 * Internal signal that a baseline operation is still `IN_PROGRESS`,
 * consumed by {@link waitForBaselineOperation}'s bounded schedule.
 */
class BaselineOperationPending extends Data.TaggedError(
  "BaselineOperationPending",
)<{
  readonly operationIdentifier: string;
  readonly status: string | undefined;
}> {}

// Explicitly-typed retry wrappers — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileBaselineOperationPending = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "BaselineOperationPending",
    // Baseline enablement provisions accounts and typically takes several
    // minutes; poll every 10s up to ~20 minutes.
    schedule: Schedule.max([
      Schedule.spaced("10 seconds"),
      Schedule.recurs(120),
    ]),
  });

// Control Tower serializes baseline operations per target — a concurrent
// operation surfaces as a typed ConflictException. Retry through it on a
// bounded schedule.
const retryWhileBaselineConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([
      Schedule.spaced("15 seconds"),
      Schedule.recurs(40),
    ]),
  });

const waitForBaselineOperation = (operationIdentifier: string) =>
  retryWhileBaselineOperationPending(
    Effect.gen(function* () {
      const { baselineOperation } = yield* controltower.getBaselineOperation({
        operationIdentifier,
      });
      if (baselineOperation.status === "SUCCEEDED") {
        return;
      }
      if (baselineOperation.status === "FAILED") {
        return yield* Effect.fail(
          new BaselineOperationFailed({
            operationIdentifier,
            status: baselineOperation.status,
            statusMessage: baselineOperation.statusMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new BaselineOperationPending({
          operationIdentifier,
          status: baselineOperation.status,
        }),
      );
    }),
  );

const readEnabledBaseline = (enabledBaselineArn: string) =>
  controltower
    .getEnabledBaseline({ enabledBaselineIdentifier: enabledBaselineArn })
    .pipe(
      Effect.map((r) => r.enabledBaselineDetails),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

// Find an enabled baseline by (baselineIdentifier, targetIdentifier) —
// covers the create-race and lost-output cases where we don't have the
// ARN cached.
const findEnabledBaselineArn = (
  baselineIdentifier: string,
  targetIdentifier: string,
) =>
  controltower.listEnabledBaselines
    .pages({
      filter: {
        baselineIdentifiers: [baselineIdentifier],
        targetIdentifiers: [targetIdentifier],
      },
    })
    .pipe(
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          Array.from(chunk).flatMap((page) => page.enabledBaselines)[0]?.arn,
      ),
    );

const toAttributes = (
  arn: string,
  details: controltower.EnabledBaselineDetails | undefined,
  fallback: {
    baselineIdentifier: string;
    targetIdentifier: string;
    baselineVersion?: string;
  },
): EnabledBaseline["Attributes"] => ({
  enabledBaselineArn: arn,
  baselineIdentifier:
    details?.baselineIdentifier ?? fallback.baselineIdentifier,
  targetIdentifier: details?.targetIdentifier ?? fallback.targetIdentifier,
  baselineVersion: details?.baselineVersion ?? fallback.baselineVersion,
});

export const EnabledBaselineProvider = () =>
  Provider.effect(
    EnabledBaseline,
    Effect.gen(function* () {
      return EnabledBaseline.Provider.of({
        stables: [
          "enabledBaselineArn",
          "baselineIdentifier",
          "targetIdentifier",
        ],
        // Enumerate every enabled baseline in the ambient account (the
        // filter-less listing is supported on management accounts; on
        // non-Control-Tower accounts there is simply nothing to list).
        list: () =>
          controltower.listEnabledBaselines.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.enabledBaselines)
                .map((summary) => ({
                  enabledBaselineArn: summary.arn,
                  baselineIdentifier: summary.baselineIdentifier,
                  targetIdentifier: summary.targetIdentifier,
                  baselineVersion: summary.baselineVersion,
                })),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.enabledBaselineArn ??
            (olds !== undefined
              ? yield* findEnabledBaselineArn(
                  olds.baselineIdentifier,
                  olds.targetIdentifier,
                )
              : undefined);
          if (arn === undefined) return undefined;
          const details = yield* readEnabledBaseline(arn);
          if (details === undefined) return undefined;
          const attrs = toAttributes(arn, details, {
            baselineIdentifier: olds?.baselineIdentifier ?? "",
            targetIdentifier: olds?.targetIdentifier ?? "",
          });
          const tags = yield* observeControlTowerTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.baselineIdentifier !== olds.baselineIdentifier ||
            news.targetIdentifier !== olds.targetIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // 1. Observe — cloud state is authoritative; output is only an
          //    ARN cache.
          let arn = output?.enabledBaselineArn;
          let details =
            arn === undefined ? undefined : yield* readEnabledBaseline(arn);
          if (details === undefined) {
            arn = yield* findEnabledBaselineArn(
              news.baselineIdentifier,
              news.targetIdentifier,
            );
            details =
              arn === undefined ? undefined : yield* readEnabledBaseline(arn);
          }

          // 2. Ensure — enable if missing and wait for the asynchronous
          //    operation to converge.
          if (details === undefined || arn === undefined) {
            const internalTags = yield* createInternalTags(id);
            const enabled = yield* retryWhileBaselineConflict(
              controltower.enableBaseline({
                baselineIdentifier: news.baselineIdentifier,
                baselineVersion: news.baselineVersion,
                targetIdentifier: news.targetIdentifier,
                parameters: news.parameters,
                tags: { ...news.tags, ...internalTags },
              }),
            );
            arn = enabled.arn;
            yield* session.note(
              `baseline operation ${enabled.operationIdentifier}`,
            );
            yield* waitForBaselineOperation(enabled.operationIdentifier);
            details = yield* readEnabledBaseline(arn);
          } else {
            // 3. Sync — version and parameters are updated in place. Diff
            //    observed state against desired; skip the API on a no-op.
            //    Parameters cannot be cleared (only replaced), so an
            //    absent `parameters` prop leaves observed parameters
            //    alone.
            const versionChanged =
              details.baselineVersion !== news.baselineVersion;
            const parametersChanged =
              news.parameters !== undefined &&
              canonicalParameters(details.parameters) !==
                canonicalParameters(news.parameters);
            if (versionChanged || parametersChanged) {
              const updated = yield* retryWhileBaselineConflict(
                controltower.updateEnabledBaseline({
                  enabledBaselineIdentifier: arn,
                  baselineVersion: news.baselineVersion,
                  parameters: news.parameters,
                }),
              );
              yield* session.note(
                `baseline operation ${updated.operationIdentifier}`,
              );
              yield* waitForBaselineOperation(updated.operationIdentifier);
              details = yield* readEnabledBaseline(arn);
            }
          }

          // 3b. Sync tags against observed cloud tags.
          yield* syncControlTowerTags(arn, id, news.tags);

          // 4. Return fresh attributes.
          return toAttributes(arn, details, {
            baselineIdentifier: news.baselineIdentifier,
            targetIdentifier: news.targetIdentifier,
            baselineVersion: news.baselineVersion,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const result = yield* retryWhileBaselineConflict(
            controltower.disableBaseline({
              enabledBaselineIdentifier: output.enabledBaselineArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (result !== undefined) {
            yield* session.note(
              `baseline operation ${result.operationIdentifier}`,
            );
            yield* waitForBaselineOperation(result.operationIdentifier);
          }
        }),
      });
    }),
  );
