import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncFraudDetectorTags } from "./internal.ts";

/**
 * An inline rule definition owned by a detector version. Fraud Detector rules
 * are versioned resources scoped to a detector; a detector version references
 * a specific rule version. Declaring rules inline here lets the detector
 * version own their whole lifecycle.
 */
export interface RuleDefinition {
  /**
   * Identifier of the rule, unique within the detector (e.g. `high_risk`).
   */
  ruleId: string;
  /**
   * The rule expression, written in the rule language (see `language`). It
   * references variables and evaluates to a boolean, e.g.
   * `$order_price > 1000 and $email == "unknown"`.
   */
  expression: string;
  /**
   * Names of the outcomes returned when the rule matches. Must reference
   * existing Fraud Detector outcomes.
   */
  outcomes: string[];
  /**
   * The rule language. Only `DETECTORPL` is supported.
   * @default "DETECTORPL"
   */
  language?: string;
  /**
   * Human-readable description of the rule.
   */
  description?: string;
}

export interface DetectorVersionProps {
  /**
   * The identifier of the detector this version belongs to. Immutable —
   * changing it replaces the detector version.
   */
  detectorId: string;
  /**
   * Human-readable description of the version. Changing it replaces the
   * version (published versions are immutable).
   */
  description?: string;
  /**
   * The rules evaluated by this version, in priority order. Changing the set
   * of rules replaces the version.
   */
  rules: RuleDefinition[];
  /**
   * How rules are evaluated: `FIRST_MATCHED` stops at the first matching rule,
   * `ALL_MATCHED` evaluates every rule. Changing it replaces the version.
   * @default "FIRST_MATCHED"
   */
  ruleExecutionMode?: string;
  /**
   * The desired status of the version: `DRAFT`, `ACTIVE`, or `INACTIVE`. Only
   * an `ACTIVE` version serves predictions. This is an in-place update.
   * @default "ACTIVE"
   */
  status?: string;
  /**
   * User-defined tags for the detector version.
   */
  tags?: Record<string, string>;
}

export interface DetectorVersion extends Resource<
  "AWS.FraudDetector.DetectorVersion",
  DetectorVersionProps,
  {
    /** The identifier of the parent detector. */
    detectorId: string;
    /** The generated version identifier, e.g. `"1"`. */
    detectorVersionId: string;
    /** The ARN of the detector version. */
    arn: string;
    /** The version status: `DRAFT`, `ACTIVE`, or `INACTIVE`. */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector detector version — the deployable revision of a
 * detector. It bundles a set of rules (owned inline here) over the detector's
 * event type and, when `ACTIVE`, serves real-time predictions via
 * `getEventPrediction`. Rules and the version are cheap, rule-based
 * configuration objects — no model training is involved.
 *
 * @resource
 * @section Creating a Detector Version
 * @example Active Version with One Rule
 * ```typescript
 * const version = yield* FraudDetector.DetectorVersion("v1", {
 *   detectorId: detector.detectorId,
 *   status: "ACTIVE",
 *   ruleExecutionMode: "FIRST_MATCHED",
 *   rules: [
 *     {
 *       ruleId: "high_risk",
 *       expression: '$email == "fraud@example.com"',
 *       outcomes: ["review"],
 *     },
 *   ],
 * });
 * ```
 */
export const DetectorVersion = Resource<DetectorVersion>(
  "AWS.FraudDetector.DetectorVersion",
);

export const DetectorVersionProvider = () =>
  Provider.effect(
    DetectorVersion,
    Effect.gen(function* () {
      /** Read a detector version by id; typed not-found → undefined. */
      const getVersion = Effect.fn(function* (
        detectorId: string,
        detectorVersionId: string,
      ) {
        return yield* frauddetector
          .getDetectorVersion({ detectorId, detectorVersionId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /**
       * Ensure every declared rule exists as a rule version and return the
       * references (create-once by `ruleId`; existing rules reuse their latest
       * version — rule-expression edits are expressed by changing `ruleId`).
       */
      const ensureRules = Effect.fn(function* (
        detectorId: string,
        rules: RuleDefinition[],
      ) {
        const refs: frauddetector.Rule[] = [];
        for (const rule of rules) {
          const existing = yield* frauddetector
            .getRules({ detectorId, ruleId: rule.ruleId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const details = existing?.ruleDetails ?? [];
          if (details.length === 0) {
            const created = yield* frauddetector.createRule({
              ruleId: rule.ruleId,
              detectorId,
              expression: rule.expression,
              language: rule.language ?? "DETECTORPL",
              outcomes: rule.outcomes,
              description: rule.description,
            });
            refs.push(created.rule!);
          } else {
            // Reuse the latest existing version of the rule.
            const latest = details.reduce((a, b) =>
              Number(b.ruleVersion ?? "0") > Number(a.ruleVersion ?? "0")
                ? b
                : a,
            );
            refs.push({
              detectorId,
              ruleId: latest.ruleId!,
              ruleVersion: latest.ruleVersion!,
            });
          }
        }
        return refs;
      });

      return {
        stables: ["detectorId", "detectorVersionId", "arn"],

        diff: Effect.fn(function* ({ olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          // Everything but status is baked into the published version — a
          // change to the detector, rules, execution mode, or description
          // replaces the version. Status transitions happen in place.
          if (
            (olds.detectorId ?? undefined) !== (news.detectorId ?? undefined) ||
            (olds.ruleExecutionMode ?? undefined) !==
              (news.ruleExecutionMode ?? undefined) ||
            (olds.description ?? undefined) !==
              (news.description ?? undefined) ||
            !deepEqual(olds.rules, news.rules)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ output }) {
          if (output?.detectorVersionId === undefined) return undefined;
          const version = yield* getVersion(
            output.detectorId,
            output.detectorVersionId,
          );
          if (version === undefined) return undefined;
          return {
            detectorId: version.detectorId!,
            detectorVersionId: version.detectorVersionId!,
            arn: version.arn!,
            status: version.status!,
          };
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const detectorId = news.detectorId;
          const desiredStatus = news.status ?? "ACTIVE";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. ENSURE the rules exist and collect their version references.
          const ruleRefs = yield* ensureRules(detectorId, news.rules);

          // 2. OBSERVE the version; create it if missing. Published versions
          //    are immutable, so any content change triggers replacement (see
          //    diff) — here we only ever create or converge status/tags.
          let detectorVersionId = output?.detectorVersionId;
          let version =
            detectorVersionId !== undefined
              ? yield* getVersion(detectorId, detectorVersionId)
              : undefined;

          if (version === undefined) {
            const created = yield* frauddetector.createDetectorVersion({
              detectorId,
              description: news.description,
              rules: ruleRefs,
              ruleExecutionMode: news.ruleExecutionMode,
              tags: Object.entries(desiredTags).map(([key, value]) => ({
                key,
                value,
              })),
            });
            detectorVersionId = created.detectorVersionId!;
            version = yield* getVersion(detectorId, detectorVersionId);
          }

          // 3. SYNC status — a new version is created in DRAFT; move it to the
          //    desired status if it drifts.
          if ((version!.status ?? undefined) !== desiredStatus) {
            yield* frauddetector.updateDetectorVersionStatus({
              detectorId,
              detectorVersionId: detectorVersionId!,
              status: desiredStatus,
            });
          }

          // 4. SYNC tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(version!.arn!, desiredTags);

          yield* session.note(detectorVersionId!);
          return {
            detectorId,
            detectorVersionId: detectorVersionId!,
            arn: version!.arn!,
            status: desiredStatus,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const { detectorId, detectorVersionId } = output;
          // Read the rules the version owns before removing it so we can clean
          // them up afterwards (rules block detector deletion otherwise).
          const version = yield* getVersion(detectorId, detectorVersionId);
          const rules = version?.rules ?? [];

          // A version must be INACTIVE before it can be deleted.
          yield* frauddetector
            .updateDetectorVersionStatus({
              detectorId,
              detectorVersionId,
              status: "INACTIVE",
            })
            .pipe(
              Effect.catchTag(
                [
                  "ValidationException",
                  "ConflictException",
                  "ResourceNotFoundException",
                ],
                () => Effect.void,
              ),
            );

          yield* frauddetector
            .deleteDetectorVersion({ detectorId, detectorVersionId })
            .pipe(
              Effect.catchTag(
                [
                  "ValidationException",
                  "ConflictException",
                  "ResourceNotFoundException",
                ],
                () => Effect.void,
              ),
            );

          // Best-effort cleanup of the owned rule versions.
          for (const rule of rules) {
            yield* frauddetector
              .deleteRule({ rule })
              .pipe(
                Effect.catchTag(
                  ["ValidationException", "ConflictException"],
                  () => Effect.void,
                ),
              );
          }
        }),

        // Detector versions are sub-resources keyed by their parent detector;
        // there is no account-wide enumeration op, so list is a no-op.
        list: () => Effect.succeed([]),
      };
    }),
  );
