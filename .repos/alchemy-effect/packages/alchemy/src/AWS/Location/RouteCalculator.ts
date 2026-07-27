import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord } from "./internal.ts";

export interface RouteCalculatorProps {
  /**
   * Name of the route calculator. Immutable — changing it replaces the
   * calculator.
   * @default ${app}-${stage}-${id}
   */
  calculatorName?: string;
  /**
   * Data provider for routing. Immutable — changing it replaces the
   * calculator. One of `Esri`, `Grab`, or `Here`.
   */
  dataSource: string;
  /**
   * Optional description of the route calculator resource.
   */
  description?: string;
  /**
   * Tags to associate with the route calculator.
   */
  tags?: Record<string, string>;
}

export interface RouteCalculator extends Resource<
  "AWS.Location.RouteCalculator",
  RouteCalculatorProps,
  {
    /** Physical name of the route calculator. */
    calculatorName: string;
    /** ARN of the route calculator. */
    calculatorArn: string;
    /** Data provider backing the calculator. */
    dataSource: string;
    /** Description of the route calculator. */
    description: string | undefined;
    /** Tags currently associated with the calculator. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Location Service route calculator. A route calculator computes
 * routes and route matrices against a chosen data provider. The data source
 * is immutable; the description can be updated in place.
 *
 * @resource
 * @section Creating Route Calculators
 * @example Basic Route Calculator
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const calculator = yield* Location.RouteCalculator("Routes", {
 *   dataSource: "Esri",
 * });
 * ```
 */
export const RouteCalculator = Resource<RouteCalculator>(
  "AWS.Location.RouteCalculator",
);

const createCalculatorName = (
  id: string,
  props: { calculatorName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.calculatorName) return props.calculatorName;
    return yield* createPhysicalName({ id, maxLength: 100 });
  });

const readCalculator = Effect.fn(function* (calculatorName: string) {
  const found = yield* location
    .describeRouteCalculator({ CalculatorName: calculatorName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!found) return undefined;
  return {
    calculatorName: found.CalculatorName,
    calculatorArn: found.CalculatorArn,
    dataSource: found.DataSource,
    description: found.Description ? found.Description : undefined,
    tags: toTagRecord(found.Tags),
  } satisfies RouteCalculator["Attributes"];
});

export const RouteCalculatorProvider = () =>
  Provider.effect(
    RouteCalculator,
    Effect.gen(function* () {
      return {
        stables: ["calculatorName", "calculatorArn"],
        list: () =>
          Effect.gen(function* () {
            const names = yield* location.listRouteCalculators.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.CalculatorName),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              names,
              (name) => readCalculator(name),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is RouteCalculator["Attributes"] =>
                attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const calculatorName =
            output?.calculatorName ??
            (yield* createCalculatorName(id, olds ?? {}));
          const state = yield* readCalculator(calculatorName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createCalculatorName(id, olds);
          const newName = yield* createCalculatorName(id, news);
          if (oldName !== newName || olds.dataSource !== news.dataSource) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const calculatorName =
            output?.calculatorName ?? (yield* createCalculatorName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let state = yield* readCalculator(calculatorName);

          if (state === undefined) {
            yield* location
              .createRouteCalculator({
                CalculatorName: calculatorName,
                DataSource: news.dataSource,
                Description: news.description,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            state = yield* readCalculator(calculatorName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(
                  `failed to read created route calculator ${calculatorName}`,
                ),
              );
            }
          }

          if (state.description !== (news.description ?? undefined)) {
            yield* location.updateRouteCalculator({
              CalculatorName: calculatorName,
              Description: news.description,
            });
          }

          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* location.untagResource({
              ResourceArn: state.calculatorArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* location.tagResource({
              ResourceArn: state.calculatorArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }

          yield* session.note(state.calculatorArn);

          const final = yield* readCalculator(calculatorName);
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `failed to read reconciled route calculator ${calculatorName}`,
              ),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .deleteRouteCalculator({ CalculatorName: output.calculatorName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
