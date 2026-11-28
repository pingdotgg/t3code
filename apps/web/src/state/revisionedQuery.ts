import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

// Outside the nodes: a node is dropped once unmounted, and the next read must
// still compare against the revision the query was last read under.
type LastRead = WeakMap<AtomRegistry.AtomRegistry, WeakMap<object, string | null>>;
const readRevisions: LastRead = new WeakMap();
const readDetails: LastRead = new WeakMap();
const lastReadOf = (lastRead: LastRead, registry: AtomRegistry.AtomRegistry) => {
  let byQuery = lastRead.get(registry);
  if (byQuery === undefined) {
    byQuery = new WeakMap();
    lastRead.set(registry, byQuery);
  }
  return byQuery;
};

// The registry keys serializable atoms' nodes by their key, not the atom.
const hasNode = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>) =>
  registry.getNodes().has(Atom.isSerializable(atom) ? atom[Atom.SerializableTypeId].key : atom);

// A query's own node can go with its last reader while the atom it takes its value from
// (an environment query's cache, on an idle TTL) still holds the value.
const isCached = (registry: AtomRegistry.AtomRegistry, query: Atom.Atom<unknown>) =>
  hasNode(registry, query) ||
  (query.initialValueTarget !== undefined && hasNode(registry, query.initialValueTarget));

const isWaiting = (value: unknown) => AsyncResult.isAsyncResult(value) && value.waiting;

const makeRevisionedFamily = (query: Atom.Atom<unknown>) =>
  Atom.family((key: string) => {
    const { revision, startedUnder, detail } = JSON.parse(key) as {
      readonly revision?: string | null;
      readonly startedUnder?: string;
      readonly detail?: string;
    };
    return Atom.readable(
      (get) => {
        // Only a node's first build compares: a node still mounted under the old
        // revision rebuilds when the query refetches, and must not refetch it again.
        if (Option.isNone(get.self())) {
          const revisions = lastReadOf(readRevisions, get.registry);
          // Nothing cached: the read below fetches fresh, which a refresh would only restart.
          const cached = isCached(get.registry, query);
          if (revision === undefined) {
            if (!cached && startedUnder !== undefined) revisions.set(query, startedUnder);
            return get(query);
          }
          const details = lastReadOf(readDetails, get.registry);
          const stale = revisions.has(query)
            ? revisions.get(query) !== revision ||
              (detail !== undefined && details.has(query) && details.get(query) !== detail)
            : // A reader without a revision may have cached it before the latest
              // workspace change.
              revision !== null || detail !== undefined;
          revisions.set(query, revision);
          if (detail !== undefined) details.set(query, detail);
          const value = get(query);
          // Deferred: this builds while React renders, and a refresh would synchronously
          // re-render the query's other readers, which React rejects.
          if (stale && cached) {
            const registry = get.registry;
            const wasWaiting = isWaiting(value);
            queueMicrotask(() => {
              // No node, as after the registry is disposed: nothing cached to refetch.
              if (!isCached(registry, query)) return;
              // A fetch that began since, as another reader's refresh, reads the same workspace.
              if (!wasWaiting && isWaiting(registry.get(query))) return;
              registry.refresh(query);
            });
          }
          return value;
        }
        return get(query);
      },
      // Refreshing the reader refetches the query it reads.
      (refresh) => refresh(query),
    );
  });

// Held as long as the query lives, so one (query, revision) pair keeps one atom; an
// `Atom.family` would hold the inner family only weakly and could swap the atom under a reader.
const revisionedFamilies = new WeakMap<
  Atom.Atom<unknown>,
  ReturnType<typeof makeRevisionedFamily>
>();
const revisionedFamily = (query: Atom.Atom<unknown>) => {
  let family = revisionedFamilies.get(query);
  if (family === undefined) {
    family = makeRevisionedFamily(query);
    revisionedFamilies.set(query, family);
  }
  return family;
};

/**
 * Reads `query` under a workspace revision (latest mutation id), which its readers share; a
 * revision other than the last one read refetches a cached query. `undefined` reads without
 * taking part. `startedUnder` records a fetch such a read starts as read under that revision;
 * `detail` is one reader's own second revision, which the other readers neither see nor reset.
 */
export function revisionedQuery<A>(
  query: Atom.Atom<A>,
  revision: string | null | undefined,
  options: { readonly startedUnder?: string | undefined; readonly detail?: string } = {},
): Atom.Atom<A> {
  if (revision === undefined && options.startedUnder === undefined) return query;
  return revisionedFamily(query)(JSON.stringify({ revision, ...options })) as Atom.Atom<A>;
}
