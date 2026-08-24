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

export interface VariableProps {
  /**
   * Name of the variable. If omitted, a unique lowercase name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * variable.
   */
  name?: string;
  /**
   * The data type of the variable: `STRING`, `INTEGER`, `FLOAT`, `BOOLEAN`, or
   * `DATETIME`. Immutable — changing it replaces the variable.
   */
  dataType: string;
  /**
   * The source of the variable's value: `EVENT`, `MODEL_SCORE`, or
   * `EXTERNAL_MODEL_SCORE`. Immutable — changing it replaces the variable.
   */
  dataSource: string;
  /**
   * The default value used when the variable is missing from an event. This is
   * an in-place update.
   */
  defaultValue: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * The semantic variable type (e.g. `IP_ADDRESS`, `PRICE`, `EMAIL_ADDRESS`).
   * If omitted, Fraud Detector infers one. This is an in-place update.
   */
  variableType?: string;
  /**
   * User-defined tags for the variable.
   */
  tags?: Record<string, string>;
}

export interface Variable extends Resource<
  "AWS.FraudDetector.Variable",
  VariableProps,
  {
    /** The name of the variable. */
    name: string;
    /** The ARN of the variable. */
    arn: string;
    /** The data type of the variable, e.g. `STRING` or `FLOAT`. */
    dataType: string;
    /** The data source of the variable, e.g. `EVENT`. */
    dataSource: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector variable — a named input to fraud-detection models
 * and rules, typed and sourced from event data or model scores. Variables are
 * cheap metadata objects.
 *
 * @resource
 * @section Creating a Variable
 * @example Event Variable
 * ```typescript
 * const email = yield* FraudDetector.Variable("email", {
 *   dataType: "STRING",
 *   dataSource: "EVENT",
 *   defaultValue: "unknown",
 *   variableType: "EMAIL_ADDRESS",
 * });
 * ```
 */
export const Variable = Resource<Variable>("AWS.FraudDetector.Variable");

export const VariableProvider = () =>
  Provider.effect(
    Variable,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Partial<VariableProps>,
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      /** Look a variable up by name; typed not-found → undefined. */
      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getVariables({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.variables?.[0];
      });

      const toAttrs = (variable: frauddetector.Variable) => ({
        name: variable.name!,
        arn: variable.arn!,
        dataType: variable.dataType!,
        dataSource: variable.dataSource!,
      });

      return {
        stables: ["name", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.dataType ?? undefined) !== (news.dataType ?? undefined) ||
            (olds.dataSource ?? undefined) !== (news.dataSource ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const variable = yield* get(name);
          if (variable === undefined) return undefined;
          const attrs = toAttrs(variable);
          const tags = yield* readFraudDetectorTags(variable.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let variable = yield* get(name);

          // 2. Ensure — create if missing (createVariable rejects duplicates
          //    with ValidationException; tolerate the race by re-reading).
          if (variable === undefined) {
            yield* frauddetector
              .createVariable({
                name,
                dataType: news.dataType,
                dataSource: news.dataSource,
                defaultValue: news.defaultValue,
                description: news.description,
                variableType: news.variableType,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(Effect.catchTag("ValidationException", () => Effect.void));
            variable = yield* get(name);
          } else {
            // 3. Sync mutable aspects — update on drift.
            const defaultDrift =
              (variable.defaultValue ?? undefined) !==
              (news.defaultValue ?? undefined);
            const descriptionDrift =
              news.description !== undefined &&
              (variable.description ?? undefined) !== news.description;
            const typeDrift =
              news.variableType !== undefined &&
              (variable.variableType ?? undefined) !== news.variableType;
            if (defaultDrift || descriptionDrift || typeDrift) {
              yield* frauddetector.updateVariable({
                name,
                defaultValue: news.defaultValue,
                description: news.description,
                variableType: news.variableType,
              });
            }
            // 3b. Sync tags — diff against OBSERVED cloud tags.
            yield* syncFraudDetectorTags(variable.arn!, desiredTags);
          }

          yield* session.note(name);
          return toAttrs(variable!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector.deleteVariable({ name: output.name }).pipe(
            // Deleting an already-removed variable is a no-op for us; Fraud
            // Detector surfaces a missing variable as a validation error.
            Effect.catchTag("ValidationException", () => Effect.void),
          );
        }),

        list: () =>
          frauddetector.getVariables.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.variables ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
