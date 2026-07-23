import * as Effect from "effect/Effect";
import { type StateService } from "./State.ts";

/**
 * Synchronize all state (every stack/stage/resource) from `source` into
 * `destination` so that `destination` becomes a mirror of `source`.
 *
 * For each `{ stack, stage, fqn }` present in `source`, the resource is
 * written into `destination`, overwriting any existing entry under the same
 * key. Any keys present in `destination` but absent from `source` are
 * deleted, ensuring the two stores end up structurally identical.
 *
 * Stacks are walked sequentially; stages within a stack and resources
 * within a stage are processed concurrently for throughput.
 */
export const syncState = Effect.fnUntraced(function* (
  source: StateService,
  destination: StateService,
  options?: {
    stacks?: string[];
    /**
     * Maximum number of resources to copy in parallel within a single stage.
     * @default "unbounded".
     */
    concurrency?: number | "unbounded";
  },
) {
  const concurrency = options?.concurrency ?? "unbounded";
  const [sourceStacks, destStacks] = yield* Effect.all([
    source.listStacks(),
    destination.listStacks(),
  ]);
  const sourceStackSet = new Set(
    sourceStacks.filter((stack) => options?.stacks?.includes(stack) ?? true),
  );

  yield* Effect.forEach(
    sourceStacks,
    Effect.fnUntraced(function* (stack) {
      const [sourceStages, destStages] = yield* Effect.all([
        source.listStages(stack),
        destination.listStages(stack),
      ]);
      const stages = union(sourceStages, destStages);

      yield* Effect.forEach(
        stages,
        Effect.fnUntraced(function* (stage) {
          const sourceFqns = yield* source.list({ stack, stage });
          const destFqns = yield* destination.list({ stack, stage });

          const sourceSet = new Set(sourceFqns);
          const toDelete = destFqns.filter((fqn) => !sourceSet.has(fqn));

          yield* Effect.all(
            [
              Effect.forEach(
                sourceFqns,
                Effect.fnUntraced(function* (fqn) {
                  const value = yield* source.get({ stack, stage, fqn });
                  if (value) {
                    yield* destination.set({ stack, stage, fqn, value });
                  }
                }),
                { concurrency },
              ),
              Effect.forEach(
                toDelete,
                (fqn) => destination.delete({ stack, stage, fqn }),
                { concurrency },
              ),
            ],
            { concurrency: "unbounded" },
          );
        }),
        { concurrency: "unbounded" },
      );
    }),
  );

  yield* Effect.forEach(
    destStacks.filter((stack) => !sourceStackSet.has(stack)),
    (stack) => destination.deleteStack({ stack }),
  );
});

const union = <T>(left: Iterable<T>, right: Iterable<T>) => [
  ...new Set([...left, ...right]),
];
