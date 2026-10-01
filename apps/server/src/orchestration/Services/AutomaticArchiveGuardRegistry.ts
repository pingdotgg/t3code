/**
 * Registry of automatic-archive admission guards.
 *
 * The engine owns this registry because it is what consults the guards while deciding commands.
 * An automatic archiver registers into it during layer construction, which keeps the rules in
 * the archiver's own module and keeps the decision core free of any archiver's policy.
 *
 * @module AutomaticArchiveGuardRegistry
 */
import type { AutomaticArchiveGuard } from "../automaticArchiveGuard.ts";
import { Context, Effect, Layer, Ref } from "effect";

export class AutomaticArchiveGuardRegistry extends Context.Service<
  AutomaticArchiveGuardRegistry,
  {
    /** Registration is idempotent per layer construction; the read model is never captured. */
    readonly register: (guard: AutomaticArchiveGuard) => Effect.Effect<void>;
    readonly guards: Effect.Effect<ReadonlyArray<AutomaticArchiveGuard>>;
  }
>()("t3/orchestration/Services/AutomaticArchiveGuardRegistry") {}

export const layer = Layer.effect(
  AutomaticArchiveGuardRegistry,
  Effect.gen(function* () {
    const guards = yield* Ref.make<ReadonlyArray<AutomaticArchiveGuard>>([]);
    return AutomaticArchiveGuardRegistry.of({
      register: (guard) => Ref.update(guards, (previous) => [...previous, guard]),
      guards: Ref.get(guards),
    });
  }),
);
