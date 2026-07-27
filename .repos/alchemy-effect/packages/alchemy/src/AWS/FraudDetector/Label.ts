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

export interface LabelProps {
  /**
   * Name of the label. If omitted, a unique lowercase name is generated from
   * the app, stage, and logical ID. Changing the name replaces the label.
   */
  name?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * User-defined tags for the label.
   */
  tags?: Record<string, string>;
}

export interface Label extends Resource<
  "AWS.FraudDetector.Label",
  LabelProps,
  {
    /** The name of the label. */
    name: string;
    /** The ARN of the label. */
    arn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector label — a classification (e.g. `fraud`, `legit`)
 * used to tag stored events for supervised model training. Event types
 * reference labels; they are cheap metadata objects.
 *
 * @resource
 * @section Creating a Label
 * @example Fraud and Legit Labels
 * ```typescript
 * const fraud = yield* FraudDetector.Label("fraud", {
 *   description: "confirmed fraudulent event",
 * });
 * const legit = yield* FraudDetector.Label("legit", {});
 * ```
 */
export const Label = Resource<Label>("AWS.FraudDetector.Label");

export const LabelProvider = () =>
  Provider.effect(
    Label,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: LabelProps) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      /** Look a label up by name; typed not-found → undefined. */
      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getLabels({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.labels?.[0];
      });

      const toAttrs = (label: frauddetector.Label) => ({
        name: label.name!,
        arn: label.arn!,
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
          const label = yield* get(name);
          if (label === undefined) return undefined;
          const attrs = toAttrs(label);
          const tags = yield* readFraudDetectorTags(label.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // putLabel is an idempotent upsert — call it to converge whether
          // creating or updating the description.
          yield* frauddetector.putLabel({
            name,
            description: news.description,
          });

          const label = yield* get(name);
          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(label!.arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(label!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector.deleteLabel({ name: output.name }).pipe(
            // Deleting an already-removed label is a no-op for us; Fraud
            // Detector surfaces a missing label as a validation error.
            Effect.catchTag("ValidationException", () => Effect.void),
          );
        }),

        list: () =>
          frauddetector.getLabels.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.labels ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
