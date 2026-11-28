import * as Scope from "../../Scope.ts"

const abandonedScopes = new WeakSet<Scope.Scope>()

/**
 * Marks `scope` and its direct children as abandoned, so engines need not
 * retain the instances of the runs under it.
 *
 * @internal
 */
export const markScopeAbandoned = (scope: Scope.Scope): void => {
  abandonedScopes.add(scope)
}

/**
 * Reports whether `scope` or its parent scope was marked abandoned.
 *
 * @internal
 */
export const isScopeAbandoned = (scope: Scope.Scope): boolean =>
  abandonedScopes.has(scope) || (scope.parent !== undefined && abandonedScopes.has(scope.parent))

/**
 * Reuses `prev` while it is still an empty child of `parent`, so replays that
 * register nothing do not grow `parent`. Otherwise forks a fresh child, which
 * keeps a superseded run's compensations apart from the next run's.
 *
 * @internal
 */
export const reuseOrForkScope = (
  prev: Scope.Closeable | undefined,
  parent: Scope.Scope
): Scope.Closeable =>
  prev !== undefined && prev.parent === parent && prev.state._tag === "Empty"
    ? prev
    : Scope.forkUnsafe(parent)
