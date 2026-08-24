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

export interface OutcomeProps {
  /**
   * Name of the outcome. If omitted, a unique lowercase name is generated from
   * the app, stage, and logical ID. Changing the name replaces the outcome.
   */
  name?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * User-defined tags for the outcome.
   */
  tags?: Record<string, string>;
}

export interface Outcome extends Resource<
  "AWS.FraudDetector.Outcome",
  OutcomeProps,
  {
    /** The name of the outcome. */
    name: string;
    /** The ARN of the outcome. */
    arn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector outcome — the result a rule produces when it matches
 * (e.g. `approve`, `review`, `block`). Detector rules reference outcomes; they
 * are cheap metadata objects.
 *
 * @resource
 * @section Creating an Outcome
 * @example Approve and Review Outcomes
 * ```typescript
 * const approve = yield* FraudDetector.Outcome("approve", {
 *   description: "let the transaction through",
 * });
 * const review = yield* FraudDetector.Outcome("review", {});
 * ```
 */
export const Outcome = Resource<Outcome>("AWS.FraudDetector.Outcome");

export const OutcomeProvider = () =>
  Provider.effect(
    Outcome,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: OutcomeProps) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      /** Look an outcome up by name; typed not-found → undefined. */
      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getOutcomes({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.outcomes?.[0];
      });

      const toAttrs = (outcome: frauddetector.Outcome) => ({
        name: outcome.name!,
        arn: outcome.arn!,
      });

      return {
        stables: ["name", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const outcome = yield* get(name);
          if (outcome === undefined) return undefined;
          const attrs = toAttrs(outcome);
          const tags = yield* readFraudDetectorTags(outcome.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // putOutcome is an idempotent upsert — call it to converge whether
          // creating or updating the description.
          yield* frauddetector.putOutcome({
            name,
            description: news.description,
          });

          const outcome = yield* get(name);
          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(outcome!.arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(outcome!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector.deleteOutcome({ name: output.name }).pipe(
            // Deleting an already-removed outcome is a no-op for us; Fraud
            // Detector surfaces a missing outcome as a validation error.
            Effect.catchTag("ValidationException", () => Effect.void),
          );
        }),

        list: () =>
          frauddetector.getOutcomes.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.outcomes ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
