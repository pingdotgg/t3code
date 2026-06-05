import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  detectorIdentity,
  matchesDetectorIdentity,
  retryConcurrent,
} from "./common.ts";

class AnomalyDetectorNotVisible extends Data.TaggedError(
  "AnomalyDetectorNotVisible",
)<{
  message: string;
}> {}

export interface AnomalyDetectorProps
  extends cloudwatch.PutAnomalyDetectorInput {}

export interface AnomalyDetector extends Resource<
  "AWS.CloudWatch.AnomalyDetector",
  AnomalyDetectorProps,
  {
    detectorId: string;
    anomalyDetector: cloudwatch.AnomalyDetector;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch anomaly detector.
 *
 * @section Creating Detectors
 * @example Single Metric Detector
 * ```typescript
 * const detector = yield* AnomalyDetector("ErrorsDetector", {
 *   Namespace: "AWS/Lambda",
 *   MetricName: "Errors",
 *   Stat: "Sum",
 * });
 * ```
 */
export const AnomalyDetector = Resource<AnomalyDetector>(
  "AWS.CloudWatch.AnomalyDetector",
);

const toDescribeRequest = (
  input: cloudwatch.PutAnomalyDetectorInput,
): cloudwatch.DescribeAnomalyDetectorsInput => {
  if (input.MetricMathAnomalyDetector) {
    return {
      AnomalyDetectorTypes: ["METRIC_MATH"],
    };
  }

  return {
    Namespace: input.Namespace,
    MetricName: input.MetricName,
    Dimensions: input.Dimensions,
    AnomalyDetectorTypes: ["SINGLE_METRIC"],
  };
};

const toDeleteRequest = (
  input: Pick<
    cloudwatch.AnomalyDetector,
    | "Namespace"
    | "MetricName"
    | "Dimensions"
    | "Stat"
    | "SingleMetricAnomalyDetector"
    | "MetricMathAnomalyDetector"
  >,
): cloudwatch.DeleteAnomalyDetectorInput => {
  if (input.MetricMathAnomalyDetector) {
    return {
      MetricMathAnomalyDetector: input.MetricMathAnomalyDetector,
    };
  }

  if (input.SingleMetricAnomalyDetector) {
    return {
      SingleMetricAnomalyDetector: input.SingleMetricAnomalyDetector,
    };
  }

  return {
    Namespace: input.Namespace,
    MetricName: input.MetricName,
    Dimensions: input.Dimensions,
    Stat: input.Stat,
  };
};

const detectorReadinessSchedule = Schedule.exponential(200).pipe(
  Schedule.both(Schedule.recurs(8)),
);

const describeDetector = Effect.fn(function* (
  props: cloudwatch.PutAnomalyDetectorInput,
  options?: {
    resourceId?: string;
    attempt?: number;
    logMisses?: boolean;
  },
) {
  const request = toDescribeRequest(props);
  const response = yield* cloudwatch.describeAnomalyDetectors(request);
  const detectors = response.AnomalyDetectors ?? [];
  const detector = detectors.find((candidate) =>
    matchesDetectorIdentity(candidate, props),
  );

  if (!detector && options?.logMisses) {
    const prefix = options.resourceId
      ? `${options.resourceId}: anomaly detector not yet visible`
      : "anomaly detector not yet visible";
    const attempt =
      options.attempt === undefined ? "" : ` (attempt ${options.attempt})`;

    yield* Effect.logInfo(
      `${prefix}${attempt}; request=${JSON.stringify(request)} candidates=${JSON.stringify(
        detectors.map((candidate) => ({
          identity: detectorIdentity(candidate),
          Namespace: candidate.Namespace,
          MetricName: candidate.MetricName,
          Stat: candidate.Stat,
          SingleMetricAnomalyDetector: candidate.SingleMetricAnomalyDetector,
          MetricMathAnomalyDetector: candidate.MetricMathAnomalyDetector,
        })),
      )}`,
    );
  }

  return detector;
});

export const AnomalyDetectorProvider = () =>
  Provider.succeed(AnomalyDetector, {
    stables: ["detectorId"],
    diff: Effect.fn(function* ({ olds = {}, news = {} }) {
      if (!isResolved(news)) return undefined;
      if (detectorIdentity(olds) !== detectorIdentity(news)) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const props = output?.anomalyDetector ?? olds;
      if (!props) {
        return undefined;
      }

      const detector = yield* describeDetector(props);

      if (!detector) {
        return undefined;
      }

      return {
        detectorId: detectorIdentity(props),
        anomalyDetector: detector,
      };
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      // Ensure — `putAnomalyDetector` is an upsert keyed by the detector's
      // identity (Namespace+MetricName+Dimensions+Stat or MetricMath
      // expression). Sending desired props every reconcile converges the
      // cloud regardless of whether this is first-create or an update.
      yield* retryConcurrent(cloudwatch.putAnomalyDetector(news));
      const detectorId = detectorIdentity(news);
      yield* session.note(detectorId);

      // Sync — describe the detector after the put. CloudWatch is
      // eventually consistent for `DescribeAnomalyDetectors`, so we retry
      // until the detector matching our identity is visible.
      let attempt = 0;
      const state = yield* Effect.suspend(() => {
        attempt += 1;
        return describeDetector(news, {
          resourceId: "AnomalyDetector",
          attempt,
          logMisses: true,
        }).pipe(
          Effect.flatMap((state) =>
            state
              ? Effect.succeed(state)
              : Effect.fail(
                  new AnomalyDetectorNotVisible({
                    message: "Anomaly detector not yet visible",
                  }),
                ),
          ),
        );
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "AnomalyDetectorNotVisible",
          schedule: detectorReadinessSchedule,
        }),
      );

      return {
        detectorId,
        anomalyDetector: state,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* retryConcurrent(
        cloudwatch.deleteAnomalyDetector(
          toDeleteRequest(output.anomalyDetector),
        ),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
  });
