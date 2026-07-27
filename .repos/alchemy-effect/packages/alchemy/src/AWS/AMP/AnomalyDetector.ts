import * as amp from "@distilled.cloud/aws/amp";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { syncAmpTags, toTagRecord } from "./internal.ts";

/**
 * Tolerance band around the expected value inside which deviations are not
 * flagged — either an absolute `amount` or a `ratio` of the expected value.
 */
export type AnomalyDetectorIgnoreNearExpected =
  | { amount: number }
  | { ratio: number };

/** What the detector does with evaluation windows that have no data. */
export type AnomalyDetectorMissingDataAction =
  | { markAsAnomaly: boolean }
  | { skip: boolean };

export interface AnomalyDetectorProps {
  /**
   * Id of the AMP workspace the detector runs in. Changing the workspace
   * replaces the detector.
   */
  workspaceId: string;
  /**
   * Human-readable alias for the detector, unique within the workspace.
   * Changing the alias replaces the detector.
   */
  alias: string;
  /**
   * The PromQL query producing the time series the Random Cut Forest
   * algorithm scores for anomalies. Updating it retrains the detector.
   */
  query: string;
  /**
   * Number of consecutive data points combined into one sample (shingle)
   * for scoring. If omitted, the service default is used.
   */
  shingleSize?: number;
  /**
   * Number of points sampled per Random Cut Forest tree. If omitted, the
   * service default is used.
   */
  sampleSize?: number;
  /**
   * Suppress anomalies above the expected value that fall within this
   * tolerance band.
   */
  ignoreNearExpectedFromAbove?: AnomalyDetectorIgnoreNearExpected;
  /**
   * Suppress anomalies below the expected value that fall within this
   * tolerance band.
   */
  ignoreNearExpectedFromBelow?: AnomalyDetectorIgnoreNearExpected;
  /**
   * How often the detector evaluates the query. Accepts any
   * `Duration.Input` (e.g. `"1 minute"`, `Duration.minutes(1)`; a bare
   * number is milliseconds); the wire unit is whole seconds
   * (`evaluationIntervalInSeconds`). If omitted, the service default is
   * used.
   */
  evaluationInterval?: Duration.Input;
  /**
   * What to do when an evaluation window has no data: mark it as an
   * anomaly (`{ markAsAnomaly: true }`) or skip it (`{ skip: true }`).
   */
  missingDataAction?: AnomalyDetectorMissingDataAction;
  /**
   * Extra labels attached to the anomaly metrics the detector emits.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags for the detector.
   */
  tags?: Record<string, string>;
}

export interface AnomalyDetector extends Resource<
  "AWS.AMP.AnomalyDetector",
  AnomalyDetectorProps,
  {
    workspaceId: string;
    anomalyDetectorId: string;
    anomalyDetectorArn: string;
    alias: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * A Random Cut Forest anomaly detector inside an Amazon Managed Service for
 * Prometheus workspace — continuously evaluates a PromQL query and emits
 * anomaly scores as new metrics in the same workspace.
 *
 * @resource
 * @section Creating an Anomaly Detector
 * @example Detect Anomalies on a Request-Rate Query
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const detector = yield* AMP.AnomalyDetector("RequestSpikes", {
 *   workspaceId: workspace.workspaceId,
 *   alias: "request-spikes",
 *   query: 'rate(http_requests_total{job="api"}[5m])',
 *   evaluationInterval: "1 minute",
 *   missingDataAction: { skip: true },
 * });
 * ```
 */
export const AnomalyDetector = Resource<AnomalyDetector>(
  "AWS.AMP.AnomalyDetector",
);

export const AnomalyDetectorProvider = () =>
  Provider.effect(
    AnomalyDetector,
    Effect.gen(function* () {
      const toAttrs = (
        workspaceId: string,
        detector: amp.AnomalyDetectorDescription,
      ) => ({
        workspaceId,
        anomalyDetectorId: detector.anomalyDetectorId,
        anomalyDetectorArn: detector.arn,
        alias: detector.alias,
        status: detector.status.statusCode,
      });

      /** Describe a detector by id; typed not-found → undefined. */
      const describe = Effect.fn(function* (
        workspaceId: string,
        anomalyDetectorId: string,
      ) {
        const response = yield* amp
          .describeAnomalyDetector({ workspaceId, anomalyDetectorId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.anomalyDetector;
      });

      /**
       * Find a detector by its alias (the deterministic identity within a
       * workspace) — used when no id is cached in `output`.
       */
      const findByAlias = Effect.fn(function* (
        workspaceId: string,
        alias: string,
      ) {
        const summary = yield* amp.listAnomalyDetectors
          .items({ workspaceId, alias })
          .pipe(
            Stream.filter((s) => s.alias === alias),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return summary === undefined
          ? undefined
          : yield* describe(workspaceId, summary.anomalyDetectorId);
      });

      /**
       * Bounded best-effort wait toward ACTIVE. Training/backfill can
       * outlast the window; the last observed description is returned and
       * a still-training detector converges on a later reconcile.
       */
      const waitSettled = Effect.fn(function* (
        workspaceId: string,
        anomalyDetectorId: string,
      ) {
        return yield* amp
          .describeAnomalyDetector({ workspaceId, anomalyDetectorId })
          .pipe(
            Effect.map((r) => r.anomalyDetector),
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
              until: (d): boolean =>
                d.status.statusCode !== "CREATING" &&
                d.status.statusCode !== "UPDATING",
            }),
          );
      });

      const canonical = (value: unknown) =>
        JSON.stringify(value, (_, v: unknown) =>
          v !== null && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(
                Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              )
            : v,
        );

      /**
       * Detect drift between desired props and the observed detector.
       * Only user-specified fields participate — omitted optional fields
       * defer to service defaults and never force a (full-retrain) put.
       */
      const configDrifts = (
        news: AnomalyDetectorProps,
        observed: amp.AnomalyDetectorDescription,
      ): boolean => {
        const rcf = observed.configuration?.randomCutForest;
        const drift =
          news.query !== rcf?.query ||
          (news.shingleSize !== undefined &&
            news.shingleSize !== rcf?.shingleSize) ||
          (news.sampleSize !== undefined &&
            news.sampleSize !== rcf?.sampleSize) ||
          (news.ignoreNearExpectedFromAbove !== undefined &&
            canonical(news.ignoreNearExpectedFromAbove) !==
              canonical(rcf?.ignoreNearExpectedFromAbove)) ||
          (news.ignoreNearExpectedFromBelow !== undefined &&
            canonical(news.ignoreNearExpectedFromBelow) !==
              canonical(rcf?.ignoreNearExpectedFromBelow)) ||
          (news.evaluationInterval !== undefined &&
            toWireSeconds(news.evaluationInterval) !==
              observed.evaluationIntervalInSeconds) ||
          (news.missingDataAction !== undefined &&
            canonical(news.missingDataAction) !==
              canonical(observed.missingDataAction)) ||
          (news.labels !== undefined &&
            canonical(news.labels) !== canonical(toTagRecord(observed.labels)));
        return drift;
      };

      const toConfiguration = (news: AnomalyDetectorProps) => ({
        randomCutForest: {
          query: news.query,
          shingleSize: news.shingleSize,
          sampleSize: news.sampleSize,
          ignoreNearExpectedFromAbove: news.ignoreNearExpectedFromAbove,
          ignoreNearExpectedFromBelow: news.ignoreNearExpectedFromBelow,
        },
      });

      return {
        stables: [
          "workspaceId",
          "anomalyDetectorId",
          "anomalyDetectorArn",
          "alias",
        ],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.workspaceId !== news.workspaceId ||
            olds?.alias !== news.alias
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const workspaceId = output?.workspaceId ?? olds?.workspaceId;
          if (!workspaceId) return undefined;
          const detector =
            output?.anomalyDetectorId !== undefined
              ? yield* describe(workspaceId, output.anomalyDetectorId)
              : olds?.alias !== undefined
                ? yield* findByAlias(workspaceId, olds.alias)
                : undefined;
          if (detector === undefined) return undefined;
          const attrs = toAttrs(workspaceId, detector);
          const tags = toTagRecord(detector.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const workspaceId = news!.workspaceId;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news!.tags };

          // 1. Observe — by cached id, falling back to the alias.
          let detector =
            output?.anomalyDetectorId !== undefined
              ? yield* describe(workspaceId, output.anomalyDetectorId)
              : yield* findByAlias(workspaceId, news!.alias);

          // 2. Ensure — create if missing.
          if (detector === undefined) {
            const created = yield* amp.createAnomalyDetector({
              workspaceId,
              alias: news!.alias,
              configuration: toConfiguration(news!),
              evaluationIntervalInSeconds: toWireSeconds(
                news!.evaluationInterval,
              ),
              missingDataAction: news!.missingDataAction,
              labels: news!.labels,
              tags: desiredTags,
            });
            detector = yield* waitSettled(
              workspaceId,
              created.anomalyDetectorId,
            );
          } else if (configDrifts(news!, detector)) {
            // 3. Sync — `putAnomalyDetector` triggers a full retrain, so it
            // is only called when an observed aspect actually drifts.
            yield* amp.putAnomalyDetector({
              workspaceId,
              anomalyDetectorId: detector.anomalyDetectorId,
              configuration: toConfiguration(news!),
              evaluationIntervalInSeconds: toWireSeconds(
                news!.evaluationInterval,
              ),
              missingDataAction: news!.missingDataAction,
              labels: news!.labels,
            });
            detector = yield* waitSettled(
              workspaceId,
              detector.anomalyDetectorId,
            );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAmpTags(detector.arn, desiredTags);

          yield* session.note(`${workspaceId}/${detector.anomalyDetectorId}`);
          return toAttrs(workspaceId, detector);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteAnomalyDetector({
              workspaceId: output.workspaceId,
              anomalyDetectorId: output.anomalyDetectorId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // A detector mid-training rejects deletion; retry briefly.
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("4 seconds"),
                  Schedule.recurs(25),
                ]),
              }),
            );
        }),

        // Sub-resource keyed by its parent workspace — not independently
        // enumerable across the account.
        list: () => Effect.succeed([]),
      };
    }),
  );
