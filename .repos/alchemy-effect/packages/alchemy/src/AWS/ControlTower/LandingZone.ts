import * as controltower from "@distilled.cloud/aws/controltower";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalJson,
  observeControlTowerTags,
  syncControlTowerTags,
} from "./internal.ts";

export interface LandingZoneProps {
  /**
   * The landing zone version, e.g. `"3.3"`. Updating the version upgrades
   * the landing zone in place (an asynchronous operation that can take an
   * hour or more).
   */
  version: string;
  /**
   * The landing zone manifest JSON document — the full configuration of
   * the landing zone (governed regions, organization structure, logging
   * and access-management settings). See the AWS Control Tower User Guide
   * for the manifest schema.
   */
  manifest: Record<string, unknown>;
  /**
   * Remediation types enabled for the landing zone, e.g.
   * `["INHERITANCE_DRIFT"]`.
   */
  remediationTypes?: string[];
  /**
   * Tags to apply to the landing zone. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface LandingZone extends Resource<
  "AWS.ControlTower.LandingZone",
  LandingZoneProps,
  {
    /**
     * The unique identifier of the landing zone (its ARN).
     */
    landingZoneIdentifier: string;
    /**
     * The ARN of the landing zone.
     */
    landingZoneArn: string;
    /**
     * The deployed landing zone version.
     */
    version: string;
    /**
     * The landing zone deployment status (`ACTIVE`, `PROCESSING`,
     * `FAILED`).
     */
    status: string | undefined;
    /**
     * The most recent landing zone version available for upgrade.
     */
    latestAvailableVersion: string | undefined;
    /**
     * The landing zone drift status (`IN_SYNC` or `DRIFTED`).
     */
    driftStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Control Tower landing zone — the org-wide multi-account
 * environment (organization structure, governed regions, centralized
 * logging, and access management) that Control Tower governs.
 *
 * A landing zone is a singleton per AWS Organization and can only be
 * managed from the Organizations management account. Creating, updating,
 * and decommissioning a landing zone are asynchronous operations that can
 * take an hour or more.
 * @resource
 * @section Creating a Landing Zone
 * @example Landing Zone from a manifest
 * ```typescript
 * import * as ControlTower from "alchemy/AWS/ControlTower";
 *
 * const landingZone = yield* ControlTower.LandingZone("LandingZone", {
 *   version: "3.3",
 *   manifest: {
 *     governedRegions: ["us-east-1", "us-west-2"],
 *     organizationStructure: {
 *       security: { name: "Security" },
 *       sandbox: { name: "Sandbox" },
 *     },
 *     centralizedLogging: {
 *       accountId: "111122223333",
 *       configurations: {
 *         loggingBucket: { retentionDays: 365 },
 *         accessLoggingBucket: { retentionDays: 365 },
 *       },
 *       enabled: true,
 *     },
 *     securityRoles: { accountId: "444455556666" },
 *     accessManagement: { enabled: true },
 *   },
 * });
 * ```
 *
 * @section Upgrading
 * @example Upgrade the landing zone version
 * ```typescript
 * const landingZone = yield* ControlTower.LandingZone("LandingZone", {
 *   version: "3.3", // bump to upgrade in place
 *   manifest,
 * });
 * ```
 */
export const LandingZone = Resource<LandingZone>(
  "AWS.ControlTower.LandingZone",
);

/**
 * An asynchronous landing zone operation (CREATE / UPDATE / DELETE /
 * RESET) converged to the terminal `FAILED` status.
 */
export class LandingZoneOperationFailed extends Data.TaggedError(
  "LandingZoneOperationFailed",
)<{
  readonly operationIdentifier: string;
  readonly status: string;
  readonly statusMessage: string | undefined;
}> {}

/**
 * Internal signal that a landing zone operation is still `IN_PROGRESS`,
 * consumed by {@link waitForLandingZoneOperation}'s bounded schedule.
 */
class LandingZoneOperationPending extends Data.TaggedError(
  "LandingZoneOperationPending",
)<{
  readonly operationIdentifier: string;
  readonly status: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileLandingZoneOperationPending = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "LandingZoneOperationPending",
    // Landing zone operations routinely take ~60 minutes; poll every 30s
    // up to 90 minutes (bounded).
    schedule: Schedule.max([
      Schedule.spaced("30 seconds"),
      Schedule.recurs(180),
    ]),
  });

const waitForLandingZoneOperation = (operationIdentifier: string) =>
  retryWhileLandingZoneOperationPending(
    Effect.gen(function* () {
      const { operationDetails } = yield* controltower.getLandingZoneOperation({
        operationIdentifier,
      });
      if (operationDetails.status === "SUCCEEDED") {
        return;
      }
      if (operationDetails.status === "FAILED") {
        return yield* Effect.fail(
          new LandingZoneOperationFailed({
            operationIdentifier,
            status: operationDetails.status,
            statusMessage: operationDetails.statusMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new LandingZoneOperationPending({
          operationIdentifier,
          status: operationDetails.status,
        }),
      );
    }),
  );

// A landing zone is a singleton per organization — `listLandingZones`
// returns at most one ARN.
const findLandingZoneArn = controltower.listLandingZones.pages({}).pipe(
  Stream.runCollect,
  Effect.map((chunk) =>
    Array.from(chunk)
      .flatMap((page) => page.landingZones)
      .map((zone) => zone.arn)
      .find((arn): arn is string => arn !== undefined),
  ),
);

const readLandingZone = (landingZoneIdentifier: string) =>
  controltower.getLandingZone({ landingZoneIdentifier }).pipe(
    Effect.map((r) => r.landingZone),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const toAttributes = (
  arn: string,
  detail: controltower.LandingZoneDetail,
): LandingZone["Attributes"] => ({
  landingZoneIdentifier: arn,
  landingZoneArn: arn,
  version: detail.version,
  status: detail.status,
  latestAvailableVersion: detail.latestAvailableVersion,
  driftStatus: detail.driftStatus?.status,
});

export const LandingZoneProvider = () =>
  Provider.effect(
    LandingZone,
    Effect.gen(function* () {
      return LandingZone.Provider.of({
        stables: ["landingZoneIdentifier", "landingZoneArn"],
        // Decommissioning a landing zone dismantles org-wide governance
        // (an irreversible, ~1 hour operation) — never do it from `nuke`.
        nuke: { skip: true },
        list: () =>
          Effect.gen(function* () {
            const arn = yield* findLandingZoneArn;
            if (arn === undefined) return [];
            const detail = yield* readLandingZone(arn);
            if (detail === undefined) return [];
            return [toAttributes(arn, detail)];
          }),
        read: Effect.fn(function* ({ id, output }) {
          const arn = output?.landingZoneArn ?? (yield* findLandingZoneArn);
          if (arn === undefined) return undefined;
          const detail = yield* readLandingZone(arn);
          if (detail === undefined) return undefined;
          const attrs = toAttributes(arn, detail);
          const tags = yield* observeControlTowerTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // 1. Observe — the landing zone is an org singleton; enumerate
          //    rather than trusting a cached identifier.
          let arn = output?.landingZoneArn ?? (yield* findLandingZoneArn);
          let detail =
            arn === undefined ? undefined : yield* readLandingZone(arn);

          // 2. Ensure — create if missing and wait for the asynchronous
          //    operation to converge.
          if (detail === undefined) {
            const internalTags = yield* createInternalTags(id);
            const created = yield* controltower.createLandingZone({
              version: news.version,
              manifest: news.manifest,
              remediationTypes: news.remediationTypes,
              tags: { ...news.tags, ...internalTags },
            });
            arn = created.arn;
            yield* session.note(
              `landing zone operation ${created.operationIdentifier}`,
            );
            yield* waitForLandingZoneOperation(created.operationIdentifier);
            detail = yield* readLandingZone(arn);
          } else {
            // 3. Sync — version / manifest / remediation types are updated
            //    in place; diff observed cloud state against desired and
            //    skip the (very slow) update API on a no-op.
            const versionChanged = detail.version !== news.version;
            const manifestChanged =
              canonicalJson(detail.manifest ?? {}) !==
              canonicalJson(news.manifest);
            const remediationChanged =
              news.remediationTypes !== undefined &&
              canonicalJson([...(detail.remediationTypes ?? [])].sort()) !==
                canonicalJson([...news.remediationTypes].sort());
            if (versionChanged || manifestChanged || remediationChanged) {
              const updated = yield* controltower.updateLandingZone({
                landingZoneIdentifier: arn!,
                version: news.version,
                manifest: news.manifest,
                remediationTypes: news.remediationTypes,
              });
              yield* session.note(
                `landing zone operation ${updated.operationIdentifier}`,
              );
              yield* waitForLandingZoneOperation(updated.operationIdentifier);
              detail = yield* readLandingZone(arn!);
            }
          }

          // 3b. Sync tags against observed cloud tags.
          yield* syncControlTowerTags(arn!, id, news.tags);

          // 4. Return fresh attributes.
          return detail === undefined
            ? {
                landingZoneIdentifier: arn!,
                landingZoneArn: arn!,
                version: news.version,
                status: undefined,
                latestAvailableVersion: undefined,
                driftStatus: undefined,
              }
            : toAttributes(arn!, detail);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const result = yield* controltower
            .deleteLandingZone({
              landingZoneIdentifier: output.landingZoneArn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (result !== undefined) {
            yield* session.note(
              `landing zone operation ${result.operationIdentifier}`,
            );
            yield* waitForLandingZoneOperation(result.operationIdentifier);
          }
        }),
      });
    }),
  );
