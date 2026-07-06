import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export interface PluginWorkspaceGrants {
  readonly grant: (root: string) => Effect.Effect<void>;
  readonly revoke: (root: string) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly snapshot: () => Effect.Effect<ReadonlySet<string>>;
}

export const makePluginWorkspaceGrants: Effect.Effect<PluginWorkspaceGrants> = Effect.gen(
  function* () {
    const roots = yield* Ref.make(new Set<string>());

    return {
      grant: (root) =>
        Ref.update(roots, (current) => {
          const next = new Set(current);
          next.add(root);
          return next;
        }),
      revoke: (root) =>
        Ref.update(roots, (current) => {
          const next = new Set(current);
          next.delete(root);
          return next;
        }),
      clear: Ref.set(roots, new Set<string>()),
      snapshot: () => Ref.get(roots).pipe(Effect.map((current) => new Set(current))),
    };
  },
);
