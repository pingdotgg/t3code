import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * How frequently GuardDuty exports updated findings.
 */
export type FindingPublishingFrequency =
  | "FIFTEEN_MINUTES"
  | "ONE_HOUR"
  | "SIX_HOURS";

export interface DetectorProps {
  /**
   * Whether the detector is enabled. A disabled detector stops analyzing data
   * sources but is not deleted.
   * @default true
   */
  enable?: boolean;

  /**
   * How frequently GuardDuty publishes updated findings to CloudWatch Events.
   * @default "SIX_HOURS"
   */
  findingPublishingFrequency?: FindingPublishingFrequency;

  /**
   * Tags applied to the detector. Alchemy ownership tags are merged in
   * automatically so the detector can be recognized on subsequent runs.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Detector extends Resource<
  "AWS.GuardDuty.Detector",
  DetectorProps,
  {
    /** The auto-generated detector ID (unique per account/region). */
    detectorId: string;
    /** ARN of the detector — the IAM resource for detector-scoped actions. */
    detectorArn: string;
    /** Current status of the detector (`ENABLED` / `DISABLED`). */
    status: string | undefined;
    /** The effective finding-publishing frequency. */
    findingPublishingFrequency: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A GuardDuty detector — the account/region singleton that enables Amazon
 * GuardDuty threat detection. Only one detector can exist per region, so this
 * resource is a capture-and-restore singleton: adopting a pre-existing detector
 * that Alchemy did not create requires `--adopt`.
 *
 * @section Enabling GuardDuty
 * @example Enable with default settings
 * ```typescript
 * const detector = yield* GuardDuty.Detector("Detector", {});
 * ```
 *
 * @example Frequent finding publishing
 * ```typescript
 * const detector = yield* GuardDuty.Detector("Detector", {
 *   enable: true,
 *   findingPublishingFrequency: "FIFTEEN_MINUTES",
 *   tags: { team: "security" },
 * });
 * ```
 */
const DetectorResource = Resource<Detector>("AWS.GuardDuty.Detector");

export { DetectorResource as Detector };

export const detectorArn = (
  region: string,
  accountId: string,
  detectorId: string,
) => `arn:aws:guardduty:${region}:${accountId}:detector/${detectorId}`;

const buildAttrs = Effect.fn(function* (
  detectorId: string,
  d: guardduty.GetDetectorResponse,
) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return {
    detectorId,
    detectorArn: detectorArn(region, accountId, detectorId),
    status: d.Status,
    findingPublishingFrequency: d.FindingPublishingFrequency,
  };
});

export const DetectorProvider = () =>
  Provider.effect(
    DetectorResource,
    Effect.gen(function* () {
      // Resolve the first (only) detector in the current region, if any.
      const firstDetectorId = guardduty
        .listDetectors({})
        .pipe(Effect.map((r) => r.DetectorIds?.[0]));

      const getDetector = (detectorId: string) =>
        guardduty
          .getDetector({ DetectorId: detectorId })
          .pipe(
            Effect.catchTag("BadRequestException", () =>
              Effect.succeed(undefined),
            ),
          );

      return {
        read: Effect.fn(function* ({ id, output }) {
          const detectorId = output?.detectorId ?? (yield* firstDetectorId);
          if (!detectorId) return undefined;
          const d = yield* getDetector(detectorId);
          if (!d) return undefined;
          const attrs = yield* buildAttrs(detectorId, d);
          return (yield* hasAlchemyTags(id, d.Tags)) ? attrs : Unowned(attrs);
        }),

        // GuardDuty allows at most one detector per account/region. Enumerate
        // every detector and hydrate its full attributes.
        list: () =>
          Effect.gen(function* () {
            const { DetectorIds } = yield* guardduty.listDetectors({});
            const out: {
              detectorId: string;
              detectorArn: string;
              status: string | undefined;
              findingPublishingFrequency: string | undefined;
            }[] = [];
            for (const detectorId of DetectorIds ?? []) {
              const d = yield* getDetector(detectorId);
              if (d) out.push(yield* buildAttrs(detectorId, d));
            }
            return out;
          }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredEnable = news.enable ?? true;

          // 1. OBSERVE — cloud state is authoritative; output is only an id cache.
          let detectorId = output?.detectorId ?? (yield* firstDetectorId);
          let live = detectorId ? yield* getDetector(detectorId) : undefined;

          if (!detectorId || !live) {
            // 2. ENSURE — create the detector with tags applied inline.
            const created = yield* guardduty.createDetector({
              Enable: desiredEnable,
              FindingPublishingFrequency: news.findingPublishingFrequency,
              Tags: desiredTags,
            });
            detectorId = created.DetectorId!;
          } else {
            // 3. SYNC settings — observed ↔ desired.
            const observedEnabled = live.Status === "ENABLED";
            const settingsChanged =
              observedEnabled !== desiredEnable ||
              (news.findingPublishingFrequency !== undefined &&
                news.findingPublishingFrequency !==
                  live.FindingPublishingFrequency);
            if (settingsChanged) {
              yield* guardduty.updateDetector({
                DetectorId: detectorId,
                Enable: desiredEnable,
                FindingPublishingFrequency: news.findingPublishingFrequency,
              });
            }

            // 3b. SYNC tags — diff against OBSERVED cloud tags.
            const { upsert, removed } = diffTags(
              tagRecord(live.Tags),
              desiredTags,
            );
            const arn = detectorArn(region, accountId, detectorId);
            if (upsert.length > 0) {
              yield* guardduty.tagResource({
                ResourceArn: arn,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* guardduty.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = yield* guardduty.getDetector({
            DetectorId: detectorId,
          });
          yield* session.note(detectorId);
          return yield* buildAttrs(detectorId, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* guardduty
            .deleteDetector({ DetectorId: output.detectorId })
            .pipe(Effect.catchTag("BadRequestException", () => Effect.void));
        }),
      };
    }),
  );
