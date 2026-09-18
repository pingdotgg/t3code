/**
 * The last list answered for an environment, carried across a reload. The registry the queries live
 * in is recreated with the renderer, so without this a revisit cold-starts into skeletons even
 * though almost every row is unchanged; hydrated, the stale rows render at once and the live read
 * reconciles them in place by key.
 *
 * An issue list and a pull request list are stored the same way and differ only in what a row is,
 * so the schema that says so — and the name the key is filed under — arrive from the caller.
 */
import * as Schema from "effect/Schema";

/** One page is what the list itself starts with, and all a cold start needs to look warm. */
const SNAPSHOT_MAX_ENTRIES = 99;

export type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * All a snapshot is handled as here. The rows are only ever counted and sliced, and the priority
 * groups only ever by whatever names the surface files them under — Assigned on one, Reviewing on
 * the other — so neither is read as anything more specific.
 */
export type WritableListSnapshot = {
  readonly scope: string;
  readonly data: { readonly entries: ReadonlyArray<unknown> };
  readonly partitions?: Readonly<Record<string, ReadonlyArray<unknown>>> | undefined;
};

const storageKey = (keyPrefix: string, environmentId: string) => `${keyPrefix}:${environmentId}`;

/**
 * Decoded with the caller's schema rather than trusted from a cast: storage is writable by anything
 * in the origin and by any past version of this app, and one malformed row would otherwise crash
 * the list on every reload until the key is cleared. A snapshot from before a schema change is
 * rejected the same way, which is exactly the cold start it would have broken.
 */
export function readListSnapshot<S extends Schema.ConstraintDecoder<unknown>>(
  storage: SnapshotStorage | undefined,
  schema: S,
  keyPrefix: string,
  environmentId: string,
): S["Type"] | null {
  try {
    const raw = storage?.getItem(storageKey(keyPrefix, environmentId));
    if (!raw) return null;
    const decoded = Schema.decodeUnknownOption(schema)(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function writeListSnapshot(
  storage: SnapshotStorage | undefined,
  keyPrefix: string,
  environmentId: string,
  snapshot: WritableListSnapshot,
): void {
  try {
    storage?.setItem(
      storageKey(keyPrefix, environmentId),
      JSON.stringify({
        scope: snapshot.scope,
        data: {
          ...snapshot.data,
          entries: snapshot.data.entries.slice(0, SNAPSHOT_MAX_ENTRIES),
          // A failure is never cached and yesterday's is not this morning's; a cursor names a
          // position in a listing the host has long since forgotten.
          errors: [],
          nextCursors: {},
        },
        ...(snapshot.partitions === undefined
          ? {}
          : {
              partitions: Object.fromEntries(
                Object.entries(snapshot.partitions).map(([group, entries]) => [
                  group,
                  entries.slice(0, SNAPSHOT_MAX_ENTRIES),
                ]),
              ),
            }),
      }),
    );
  } catch {
    // Storage can be full or denied; the snapshot is a convenience, not a record.
  }
}
