import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

/** File format of the hosted threat intelligence list. */
export type ThreatIntelSetFormat =
  | "TXT"
  | "STIX"
  | "OTX_CSV"
  | "ALIEN_VAULT"
  | "PROOF_POINT"
  | "FIRE_EYE";

export interface ThreatIntelSetProps {
  /**
   * ID of the detector the threat intel set belongs to. Changing this
   * replaces the set.
   */
  detectorId: string;

  /**
   * Display name of the threat intel set. If omitted, a unique name is
   * generated. Updatable in place.
   */
  name?: string;

  /**
   * Format of the file hosting the threat list. Changing this replaces the
   * set.
   */
  format: ThreatIntelSetFormat;

  /**
   * S3 URI of the file containing known malicious IP addresses, e.g.
   * `https://s3.amazonaws.com/my-bucket/threats.txt`. Updatable in place.
   */
  location: string;

  /**
   * Whether GuardDuty actively uses the list. Traffic to/from listed IPs
   * generates findings while active. Updatable in place.
   * @default true
   */
  activate?: boolean;

  /**
   * Account ID of the bucket owner hosting the list (guards against bucket
   * squatting).
   */
  expectedBucketOwner?: string;

  /**
   * Tags applied to the threat intel set. Alchemy ownership tags are merged
   * in automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface ThreatIntelSet extends Resource<
  "AWS.GuardDuty.ThreatIntelSet",
  ThreatIntelSetProps,
  {
    /** ID of the detector the set belongs to. */
    detectorId: string;
    /** The auto-generated threat intel set ID. */
    threatIntelSetId: string;
    /** ARN of the threat intel set. */
    threatIntelSetArn: string;
    /** Display name of the set. */
    name: string;
    /** File format of the hosted list. */
    format: string;
    /** S3 URI of the hosted list. */
    location: string;
    /** Current status (`ACTIVE`, `INACTIVE`, `ACTIVATING`, `ERROR`, …). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * A GuardDuty threat intelligence set — an S3-hosted list of known malicious
 * IP addresses that GuardDuty generates findings for. The list file must
 * exist in S3 before activation; name, location, and activation are
 * updatable in place, while format changes replace the set.
 *
 * @section Custom Threat Intelligence
 * @example Feed a custom threat list
 * ```typescript
 * const detector = yield* AWS.GuardDuty.Detector("Detector", {});
 * const threats = yield* AWS.GuardDuty.ThreatIntelSet("BadIPs", {
 *   detectorId: detector.detectorId,
 *   format: "TXT",
 *   location: "https://s3.amazonaws.com/my-security-bucket/threats.txt",
 * });
 * ```
 */
const ThreatIntelSetResource = Resource<ThreatIntelSet>(
  "AWS.GuardDuty.ThreatIntelSet",
);

export { ThreatIntelSetResource as ThreatIntelSet };

const threatIntelSetArn = (
  region: string,
  accountId: string,
  detectorId: string,
  threatIntelSetId: string,
) =>
  `arn:aws:guardduty:${region}:${accountId}:detector/${detectorId}/threatintelset/${threatIntelSetId}`;

/** Statuses that count as "the set is (becoming) active". */
const ACTIVE_STATUSES = ["ACTIVE", "ACTIVATING"];

export const ThreatIntelSetProvider = () =>
  Provider.effect(
    ThreatIntelSetResource,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string }) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      const getSet = (detectorId: string, threatIntelSetId: string) =>
        guardduty
          .getThreatIntelSet({
            DetectorId: detectorId,
            ThreatIntelSetId: threatIntelSetId,
          })
          .pipe(
            Effect.catchTag("BadRequestException", () =>
              Effect.succeed(undefined),
            ),
          );

      // Recover the set id after state loss by matching the deterministic
      // name across the detector's threat intel sets.
      const findByName = Effect.fn(function* (
        detectorId: string,
        name: string,
      ) {
        const pages = yield* guardduty.listThreatIntelSets
          .pages({ DetectorId: detectorId })
          .pipe(Stream.runCollect);
        for (const threatIntelSetId of Array.from(pages).flatMap(
          (page) => page.ThreatIntelSetIds ?? [],
        )) {
          const s = yield* getSet(detectorId, threatIntelSetId);
          if (s?.Name === name && s.Status !== "DELETE_PENDING") {
            return { threatIntelSetId, set: s };
          }
        }
        return undefined;
      });

      const buildAttrs = Effect.fn(function* (
        detectorId: string,
        threatIntelSetId: string,
        s: guardduty.GetThreatIntelSetResponse,
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          detectorId,
          threatIntelSetId,
          threatIntelSetArn: threatIntelSetArn(
            region,
            accountId,
            detectorId,
            threatIntelSetId,
          ),
          name: s.Name,
          format: s.Format,
          location: s.Location,
          status: s.Status,
        };
      });

      return {
        stables: ["detectorId", "threatIntelSetId", "threatIntelSetArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          if (
            olds.detectorId !== news.detectorId ||
            olds.format !== news.format
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const detectorId = output?.detectorId ?? olds?.detectorId;
          if (!detectorId) return undefined;
          let threatIntelSetId = output?.threatIntelSetId;
          let set = threatIntelSetId
            ? yield* getSet(detectorId, threatIntelSetId)
            : undefined;
          if (!set) {
            const found = yield* findByName(
              detectorId,
              yield* toName(id, olds ?? {}),
            );
            if (!found) return undefined;
            ({ threatIntelSetId, set } = found);
          }
          const attrs = yield* buildAttrs(detectorId, threatIntelSetId!, set);
          return (yield* hasAlchemyTags(id, set.Tags)) ? attrs : Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { DetectorIds } = yield* guardduty.listDetectors({});
            const out: ThreatIntelSet["Attributes"][] = [];
            for (const detectorId of DetectorIds ?? []) {
              const pages = yield* guardduty.listThreatIntelSets
                .pages({ DetectorId: detectorId })
                .pipe(Stream.runCollect);
              for (const threatIntelSetId of Array.from(pages).flatMap(
                (page) => page.ThreatIntelSetIds ?? [],
              )) {
                const s = yield* getSet(detectorId, threatIntelSetId);
                if (s) {
                  out.push(yield* buildAttrs(detectorId, threatIntelSetId, s));
                }
              }
            }
            return out;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const detectorId = news.detectorId;
          const name = yield* toName(id, news);
          const desiredActivate = news.activate ?? true;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — output.threatIntelSetId is only a cache; fall back
          // to a name search so a crash-and-retry converges.
          let threatIntelSetId = output?.threatIntelSetId;
          let live = threatIntelSetId
            ? yield* getSet(detectorId, threatIntelSetId)
            : undefined;
          if (!live) {
            const found = yield* findByName(detectorId, name);
            if (found) ({ threatIntelSetId, set: live } = found);
          }

          if (!live || !threatIntelSetId) {
            // 2. ENSURE — create with tags applied inline.
            const created = yield* guardduty.createThreatIntelSet({
              DetectorId: detectorId,
              Name: name,
              Format: news.format,
              Location: news.location,
              Activate: desiredActivate,
              ExpectedBucketOwner: news.expectedBucketOwner,
              Tags: desiredTags,
            });
            threatIntelSetId = created.ThreatIntelSetId;
          } else {
            // 3. SYNC settings — observed ↔ desired.
            const observedActive = ACTIVE_STATUSES.includes(live.Status);
            const drift =
              live.Name !== name ||
              live.Location !== news.location ||
              observedActive !== desiredActivate;
            if (drift) {
              yield* guardduty.updateThreatIntelSet({
                DetectorId: detectorId,
                ThreatIntelSetId: threatIntelSetId,
                Name: name,
                Location: news.location,
                Activate: desiredActivate,
                ExpectedBucketOwner: news.expectedBucketOwner,
              });
            }

            // 3b. SYNC tags — diff against OBSERVED cloud tags.
            const { accountId, region } = yield* AWSEnvironment.current;
            const arn = threatIntelSetArn(
              region,
              accountId,
              detectorId,
              threatIntelSetId,
            );
            const { upsert, removed } = diffTags(
              tagRecord(live.Tags),
              desiredTags,
            );
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
          const final = yield* guardduty.getThreatIntelSet({
            DetectorId: detectorId,
            ThreatIntelSetId: threatIntelSetId,
          });
          yield* session.note(`${detectorId}/${threatIntelSetId}`);
          return yield* buildAttrs(detectorId, threatIntelSetId, final);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the set (or its whole detector) may already be
          // gone; both surface as BadRequestException.
          yield* guardduty
            .deleteThreatIntelSet({
              DetectorId: output.detectorId,
              ThreatIntelSetId: output.threatIntelSetId,
            })
            .pipe(Effect.catchTag("BadRequestException", () => Effect.void));
        }),
      };
    }),
  );
