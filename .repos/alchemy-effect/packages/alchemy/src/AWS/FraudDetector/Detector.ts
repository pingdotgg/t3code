import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readFraudDetectorTags, syncFraudDetectorTags } from "./internal.ts";

export interface DetectorProps {
  /**
   * The detector identifier. If omitted, a unique lowercase id is generated
   * from the app, stage, and logical ID. Changing it replaces the detector.
   */
  detectorId?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * Name of the event type this detector evaluates. Immutable — changing it
   * replaces the detector.
   */
  eventTypeName: string;
  /**
   * User-defined tags for the detector.
   */
  tags?: Record<string, string>;
}

export interface Detector extends Resource<
  "AWS.FraudDetector.Detector",
  DetectorProps,
  {
    /** The detector identifier. */
    detectorId: string;
    /** The ARN of the detector. */
    arn: string;
    /** The event type the detector evaluates. */
    eventTypeName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector detector — the container that binds an event type
 * to versioned rule sets and models used to evaluate fraud. Creating the
 * detector is cheap; the rules, models, and detector versions that produce
 * predictions are provisioned separately.
 *
 * @resource
 * @section Creating a Detector
 * @example Basic Detector
 * ```typescript
 * const detector = yield* FraudDetector.Detector("checkout", {
 *   eventTypeName: purchase.name,
 * });
 * ```
 *
 * @example Detector with an Active Version
 * ```typescript
 * const detector = yield* FraudDetector.Detector("checkout", {
 *   eventTypeName: purchase.name,
 * });
 *
 * const version = yield* FraudDetector.DetectorVersion("v1", {
 *   detectorId: detector.detectorId,
 *   status: "ACTIVE",
 *   rules: [
 *     {
 *       ruleId: "high_risk",
 *       expression: '$email == "fraud@example.com"',
 *       outcomes: [review.name],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Runtime Predictions
 * Bind `GetEventPrediction` in the init phase (providing the
 * `GetEventPredictionHttp` layer on the Function effect) and score events at
 * runtime against the detector's `ACTIVE` version.
 *
 * @example Score an event from a Lambda
 * ```typescript
 * // init
 * const getEventPrediction = yield* FraudDetector.GetEventPrediction(detector);
 *
 * // runtime
 * const { ruleResults } = yield* getEventPrediction({
 *   eventId: "order-123",
 *   eventTypeName: "purchase",
 *   eventTimestamp: new Date().toISOString(),
 *   entities: [{ entityType: "customer", entityId: "cust-1" }],
 *   eventVariables: { email: "buyer@example.com", ip: "1.2.3.4" },
 * });
 * ```
 */
export const Detector = Resource<Detector>("AWS.FraudDetector.Detector");

export const DetectorProvider = () =>
  Provider.effect(
    Detector,
    Effect.gen(function* () {
      const createId = Effect.fn(function* (
        id: string,
        props: Partial<DetectorProps>,
      ) {
        return (
          props.detectorId ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      const get = Effect.fn(function* (detectorId: string) {
        const response = yield* frauddetector
          .getDetectors({ detectorId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.detectors?.[0];
      });

      const toAttrs = (detector: frauddetector.Detector) => ({
        detectorId: detector.detectorId!,
        arn: detector.arn!,
        eventTypeName: detector.eventTypeName!,
      });

      return {
        stables: ["detectorId", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldId = yield* createId(id, olds);
          const newId = yield* createId(id, news);
          if (
            oldId !== newId ||
            (olds.eventTypeName ?? undefined) !==
              (news.eventTypeName ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const detectorId =
            output?.detectorId ?? (yield* createId(id, olds ?? {}));
          const detector = yield* get(detectorId);
          if (detector === undefined) return undefined;
          const attrs = toAttrs(detector);
          const tags = yield* readFraudDetectorTags(detector.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const detectorId = yield* createId(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // putDetector is an idempotent upsert — call it to converge whether
          // creating or updating the description.
          yield* frauddetector.putDetector({
            detectorId,
            description: news.description,
            eventTypeName: news.eventTypeName,
          });

          const detector = yield* get(detectorId);
          yield* syncFraudDetectorTags(detector!.arn!, desiredTags);

          yield* session.note(detectorId);
          return toAttrs(detector!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector
            .deleteDetector({ detectorId: output.detectorId })
            .pipe(Effect.catchTag("ValidationException", () => Effect.void));
        }),

        list: () =>
          frauddetector.getDetectors.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.detectors ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
