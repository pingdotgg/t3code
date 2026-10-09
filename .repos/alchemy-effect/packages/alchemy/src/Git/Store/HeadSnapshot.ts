/**
 * The repo head snapshot (DESIGN.md §21, "Continuity learnings"): a tiny
 * JSON object in the BlobStore describing a repository's current serving
 * state. The Repo DO rewrites it after every commit that changes what an
 * anonymous reader could see (push, ref write, meta change, bundle cut),
 * and the Worker uses it to answer public read traffic — the `info/refs`
 * advertisement and bundle-covered full clones — without waking the DO.
 *
 * Consistency: the snapshot is written AFTER the SQLite commit and
 * before the response, so read-your-writes holds for the writer. A crash
 * between commit and write leaves a stale snapshot until the next
 * mutation (the post-push bundle alarm rewrites it seconds later). The
 * DO remains authoritative: authenticated traffic never reads this.
 */
import type { BundleInfo } from "../Jobs/Bundle.ts";

/** One advertised ref (peeled target present for annotated tags). */
export interface HeadRef {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string | undefined;
}

export interface HeadSnapshot {
  readonly v: 1;
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  /** Anonymous read access (the GitHub public-repo model). */
  readonly public: boolean;
  readonly readOnly: boolean;
  readonly defaultBranch: string;
  readonly refs: ReadonlyArray<HeadRef>;
  /** The current clone bundle, when one covers these refs. */
  readonly bundle?: BundleInfo | undefined;
}

export const encodeHeadSnapshot = (snapshot: HeadSnapshot): string =>
  JSON.stringify(snapshot);

/** `undefined` on malformed/foreign content — callers fall to the DO. */
export const decodeHeadSnapshot = (raw: string): HeadSnapshot | undefined => {
  try {
    const parsed = JSON.parse(raw) as HeadSnapshot;
    return parsed.v === 1 && Array.isArray(parsed.refs) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
