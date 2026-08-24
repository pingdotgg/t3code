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

export interface EnabledControlProps {
  /**
   * The identifier (ARN) of the control to enable, e.g.
   * `arn:aws:controltower:us-west-2::control/AWS-GR_ENCRYPTED_VOLUMES` or a
   * Control Catalog ARN. Changing the control replaces the enablement.
   */
  controlIdentifier: string;
  /**
   * The ARN of the organizational unit the control is enabled on.
   * Changing the target replaces the enablement.
   */
  targetIdentifier: string;
  /**
   * Parameters for configurable controls, as `{ key, value }` pairs.
   * Updated in place via `UpdateEnabledControl`.
   */
  parameters?: { key: string; value: any }[];
  /**
   * Tags to apply to the enabled control. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface EnabledControl extends Resource<
  "AWS.ControlTower.EnabledControl",
  EnabledControlProps,
  {
    /**
     * The ARN of the enabled control.
     */
    enabledControlArn: string;
    /**
     * The identifier of the enabled control.
     */
    controlIdentifier: string;
    /**
     * The ARN of the organizational unit the control is enabled on.
     */
    targetIdentifier: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Control Tower control (guardrail) enabled on an organizational
 * unit. Enabling a control starts an asynchronous operation that deploys
 * governance resources (SCPs, Config rules, or hooks) to the OU and the
 * accounts it contains.
 *
 * Requires an AWS Control Tower landing zone and can only be managed from
 * the Organizations management account.
 * @resource
 * @section Enabling Controls
 * @example Enable a preventive guardrail on an OU
 * ```typescript
 * import * as ControlTower from "alchemy/AWS/ControlTower";
 *
 * const encryptedVolumes = yield* ControlTower.EnabledControl("EncryptedVolumes", {
 *   controlIdentifier:
 *     "arn:aws:controltower:us-west-2::control/AWS-GR_ENCRYPTED_VOLUMES",
 *   targetIdentifier: "arn:aws:organizations::111122223333:ou/o-example/ou-example",
 * });
 * ```
 *
 * @example Enable a configurable control with parameters
 * ```typescript
 * const regionDeny = yield* ControlTower.EnabledControl("RegionDeny", {
 *   controlIdentifier:
 *     "arn:aws:controlcatalog:::control/50utmyu7yqmhr8fpnpo8bnaj1",
 *   targetIdentifier: ouArn,
 *   parameters: [
 *     { key: "AllowedRegions", value: ["us-east-1", "us-west-2"] },
 *   ],
 * });
 * ```
 */
export const EnabledControl = Resource<EnabledControl>(
  "AWS.ControlTower.EnabledControl",
);

/**
 * An asynchronous control operation (ENABLE_CONTROL / DISABLE_CONTROL /
 * UPDATE_ENABLED_CONTROL) converged to the terminal `FAILED` status.
 */
export class ControlOperationFailed extends Data.TaggedError(
  "ControlOperationFailed",
)<{
  readonly operationIdentifier: string;
  readonly status: string;
  readonly statusMessage: string | undefined;
}> {}

/**
 * `EnableControl` succeeded but the enabled control's ARN could not be
 * resolved from either the operation output or `ListEnabledControls`.
 */
export class EnabledControlArnUnavailable extends Data.TaggedError(
  "EnabledControlArnUnavailable",
)<{
  readonly controlIdentifier: string;
  readonly targetIdentifier: string;
}> {}

/**
 * Internal signal that a control operation is still `IN_PROGRESS`,
 * consumed by {@link waitForControlOperation}'s bounded schedule.
 */
class ControlOperationPending extends Data.TaggedError(
  "ControlOperationPending",
)<{
  readonly operationIdentifier: string;
  readonly status: string | undefined;
}> {}

// Explicitly-typed retry wrappers — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileControlOperationPending = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ControlOperationPending",
    // Control operations deploy SCPs/Config rules across an OU's accounts
    // and typically take a few minutes; poll every 10s up to ~15 minutes.
    schedule: Schedule.max([
      Schedule.spaced("10 seconds"),
      Schedule.recurs(90),
    ]),
  });

// Control Tower serializes control operations per OU — a concurrent
// operation surfaces as a typed ConflictException. Retry through it on a
// bounded schedule.
const retryWhileControlConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([
      Schedule.spaced("15 seconds"),
      Schedule.recurs(40),
    ]),
  });

const waitForControlOperation = (operationIdentifier: string) =>
  retryWhileControlOperationPending(
    Effect.gen(function* () {
      const { controlOperation } = yield* controltower.getControlOperation({
        operationIdentifier,
      });
      if (controlOperation.status === "SUCCEEDED") {
        return;
      }
      if (controlOperation.status === "FAILED") {
        return yield* Effect.fail(
          new ControlOperationFailed({
            operationIdentifier,
            status: controlOperation.status,
            statusMessage: controlOperation.statusMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new ControlOperationPending({
          operationIdentifier,
          status: controlOperation.status,
        }),
      );
    }),
  );

const readEnabledControl = (enabledControlArn: string) =>
  controltower
    .getEnabledControl({ enabledControlIdentifier: enabledControlArn })
    .pipe(
      Effect.map((r) => r.enabledControlDetails),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

// Find an enabled control by (controlIdentifier, targetIdentifier) —
// covers the create-race and lost-output cases where we don't have the
// ARN cached.
const findEnabledControlArn = (
  controlIdentifier: string,
  targetIdentifier: string,
) =>
  controltower.listEnabledControls.pages({ targetIdentifier }).pipe(
    Stream.runCollect,
    Effect.map(
      (chunk) =>
        Array.from(chunk)
          .flatMap((page) => page.enabledControls)
          .find((summary) => summary.controlIdentifier === controlIdentifier)
          ?.arn,
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

export const EnabledControlProvider = () =>
  Provider.effect(
    EnabledControl,
    Effect.gen(function* () {
      return EnabledControl.Provider.of({
        stables: ["enabledControlArn", "controlIdentifier", "targetIdentifier"],
        // Enumeration requires a target OU — there is no org-wide listing
        // that returns the full attribute shape without the management
        // account's OU tree, so nuke discovery is not supported.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.enabledControlArn ??
            (olds !== undefined
              ? yield* findEnabledControlArn(
                  olds.controlIdentifier,
                  olds.targetIdentifier,
                )
              : undefined);
          if (arn === undefined) return undefined;
          const details = yield* readEnabledControl(arn);
          if (details === undefined) return undefined;
          const attrs = {
            enabledControlArn: arn,
            controlIdentifier:
              details.controlIdentifier ?? olds?.controlIdentifier ?? "",
            targetIdentifier:
              details.targetIdentifier ?? olds?.targetIdentifier ?? "",
          };
          const tags = yield* observeControlTowerTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.controlIdentifier !== olds.controlIdentifier ||
            news.targetIdentifier !== olds.targetIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // 1. Observe — cloud state is authoritative; output is only an
          //    ARN cache.
          let arn = output?.enabledControlArn;
          let details =
            arn === undefined ? undefined : yield* readEnabledControl(arn);
          if (details === undefined) {
            arn = yield* findEnabledControlArn(
              news.controlIdentifier,
              news.targetIdentifier,
            );
            details =
              arn === undefined ? undefined : yield* readEnabledControl(arn);
          }

          // 2. Ensure — enable if missing and wait for the asynchronous
          //    operation to converge.
          if (details === undefined) {
            const internalTags = yield* createInternalTags(id);
            const enabled = yield* retryWhileControlConflict(
              controltower.enableControl({
                controlIdentifier: news.controlIdentifier,
                targetIdentifier: news.targetIdentifier,
                parameters: news.parameters,
                tags: { ...news.tags, ...internalTags },
              }),
            );
            yield* session.note(
              `control operation ${enabled.operationIdentifier}`,
            );
            yield* waitForControlOperation(enabled.operationIdentifier);
            arn =
              enabled.arn ??
              (yield* findEnabledControlArn(
                news.controlIdentifier,
                news.targetIdentifier,
              ));
            if (arn === undefined) {
              return yield* Effect.fail(
                new EnabledControlArnUnavailable({
                  controlIdentifier: news.controlIdentifier,
                  targetIdentifier: news.targetIdentifier,
                }),
              );
            }
            details = yield* readEnabledControl(arn);
          } else if (news.parameters !== undefined) {
            // 3. Sync — parameters are the only in-place-mutable aspect.
            //    Diff observed parameter summaries against desired; skip
            //    the API on a no-op. Parameters cannot be cleared (the
            //    update API requires them), so an absent `parameters` prop
            //    leaves observed parameters alone.
            const observed = canonicalParameters(details.parameters);
            const desired = canonicalParameters(news.parameters);
            if (observed !== desired) {
              const updated = yield* retryWhileControlConflict(
                controltower.updateEnabledControl({
                  enabledControlIdentifier: arn!,
                  parameters: news.parameters,
                }),
              );
              yield* session.note(
                `control operation ${updated.operationIdentifier}`,
              );
              yield* waitForControlOperation(updated.operationIdentifier);
            }
          }

          // 3b. Sync tags against observed cloud tags.
          yield* syncControlTowerTags(arn!, id, news.tags);

          // 4. Return fresh attributes.
          return {
            enabledControlArn: arn!,
            controlIdentifier: news.controlIdentifier,
            targetIdentifier: news.targetIdentifier,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const result = yield* retryWhileControlConflict(
            controltower.disableControl({
              enabledControlIdentifier: output.enabledControlArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          if (result !== undefined) {
            yield* session.note(
              `control operation ${result.operationIdentifier}`,
            );
            yield* waitForControlOperation(result.operationIdentifier);
          }
        }),
      });
    }),
  );
