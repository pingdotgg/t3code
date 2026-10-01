// The engine owns this registry because it is what consults the guards; an archiver registers
// into it so the decision core never imports the archiver's rules.
import type { AutomaticArchiveGuard } from "../automaticArchiveGuard.ts";
import { Context, Effect, Layer, Ref } from "effect";

export class AutomaticArchiveGuardRegistry extends Context.Service<
  AutomaticArchiveGuardRegistry,
  {
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
