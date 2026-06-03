import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface NamespaceNode {
  Id: string;
  Parent?: NamespaceNode;
}

export class Namespace extends Context.Service<Namespace, NamespaceNode>()(
  "Alchemy/Namespace",
) {}

export function push<const Id extends string, A, Err = never, Req = never>(
  id: Id,
  eff: Effect.Effect<A, Err, Req>,
): Effect.Effect<A, Err, Req>;

export function push<const Id extends string>(
  id: Id,
): <A, Err = never, Req = never>(
  eff: Effect.Effect<A, Err, Req>,
) => Effect.Effect<A, Err, Req>;

export function push(id: string, eff?: Effect.Effect<any, any, any>) {
  return eff
    ? Effect.flatMap(CurrentNamespace, (parent) =>
        Effect.provideService(eff, Namespace, {
          Id: id,
          Parent: parent,
        }),
      )
    : (eff: Effect.Effect<any, any, any>) => push(id, eff);
}

export const set = (namespace: string | NamespaceNode) =>
  Effect.provideService(
    Namespace,
    typeof namespace === "string" ? { Id: namespace } : namespace,
  );

export const CurrentNamespace = Effect.serviceOption(Namespace)

  .pipe(Effect.map(Option.getOrUndefined));

export const CurrentChain = CurrentNamespace.pipe(
  Effect.map(function findRoot(ns): string[] {
    if (ns?.Parent) {
      return [ns.Id, ...findRoot(ns.Parent)];
    }
    return ns ? [ns.Id] : [];
  }),
);

export const Parent = Namespace.pipe(Effect.map((ns) => ns?.Parent));

export const Root = Namespace.pipe(
  Effect.map(function findRoot(ns) {
    if (ns.Parent) {
      return findRoot(ns.Parent);
    }
    return ns;
  }),
);
