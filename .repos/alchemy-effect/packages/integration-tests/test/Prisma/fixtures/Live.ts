import { expect } from "@alchemy.run/test";
import type * as Test from "@alchemy.run/test/Alchemy";
import { getProject } from "@distilled.cloud/prisma/management";
import { isActionState, State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Poll `read` (true = gone) until it reports gone, then assert it. */
export const expectGone = <E, R>(read: Effect.Effect<boolean, E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (gone) => gone,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

export const expectProjectGone = (id: string) =>
  expectGone(
    getProject({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

/** Drop a resource's state row, as if the state store lost it. The cloud resource stays. */
export const forgetState = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.delete({ stack: stack.name, stage: stack.stage, fqn });
  }).pipe(Effect.provide(stack.state));

/** Overwrite fields of a created resource's persisted attributes. */
export const patchStateAttr = (
  stack: Test.ScratchStack,
  fqn: string,
  patch: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored) || stored.status !== "created") {
      return yield* Effect.die(new Error(`Expected a created state row for '${fqn}'`));
    }
    yield* state.set({
      ...address,
      value: { ...stored, attr: { ...(stored.attr as object), ...patch } },
    });
  }).pipe(Effect.provide(stack.state));

/** Run an effect that must fail; return its failure and defect values and the printed cause. */
export const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap(() => Effect.die(new Error("Expected the deploy to fail"))),
    Effect.catchCause((cause) =>
      Effect.succeed({
        errors: cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason)
            ? [reason.error]
            : Cause.isDieReason(reason)
              ? [reason.defect]
              : [],
        ),
        text: Cause.pretty(cause),
      }),
    ),
  );

/**
 * Turn a created row into an interrupted create: status `creating`, no
 * attributes, same instance ID. The next deploy must recover the resource.
 */
export const markCreating = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored) || stored.status !== "created") {
      return yield* Effect.die(new Error(`Expected a created state row for '${fqn}'`));
    }
    const { attr: _attr, ...creating } = stored;
    yield* state.set({ ...address, value: { ...creating, status: "creating" } as never });
  }).pipe(Effect.provide(stack.state));
