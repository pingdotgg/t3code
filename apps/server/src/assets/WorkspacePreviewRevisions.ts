import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { readFileRevision } from "./MediaFile.ts";

const MAX_TRACKED_DOCUMENTS = 64;
export const MAX_TRACKED_FILES_PER_DOCUMENT = 256;
const REVISION_READ_CONCURRENCY = 8;

/** One opened HTML page: the canonical workspace root and the page's path below it. */
export interface PreviewDocument {
  readonly workspaceRoot: string;
  readonly entryRelativePath: string;
}

interface DocumentState {
  version: number;
  /** The page loads more files than are tracked, so no revision can speak for it. */
  overflowed: boolean;
  /** What each file the page asked for looked like when last compared; null while it is missing. */
  readonly files: Map<string, string | null>;
  /** Reads are recorded one batch at a time, so an older read never overwrites a newer one. */
  readonly comparing: Semaphore.Semaphore;
}

/**
 * Tells an unchanged HTML preview from an edited one. A page's revision covers the page and the
 * files it has requested, and no other file: an edit elsewhere, even next to it, leaves it alone.
 */
export class WorkspacePreviewRevisions extends Context.Service<
  WorkspacePreviewRevisions,
  {
    /** Undefined when the page cannot be tracked; the client then reloads on workspace changes. */
    readonly revision: (document: PreviewDocument) => Effect.Effect<string | undefined>;
    /** Records a file the page requested, found or not, as part of the page. */
    readonly observe: (document: PreviewDocument, relativePath: string) => Effect.Effect<void>;
  }
>()("t3/assets/WorkspacePreviewRevisions") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  // Tracked files are forgotten on restart, so revisions from an earlier process must not match.
  const processId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  // Insertion order is recency: the least recently minted document is dropped first.
  const documents = new Map<string, DocumentState>();
  // One counter for all documents, so a document tracked again never repeats a revision.
  let versions = 0;

  const documentKey = (document: PreviewDocument) =>
    JSON.stringify([document.workspaceRoot, document.entryRelativePath]);

  const record = (state: DocumentState, relativePath: string, revision: string | null) => {
    if (!state.files.has(relativePath)) {
      if (state.files.size >= MAX_TRACKED_FILES_PER_DOCUMENT) state.overflowed = true;
      else state.files.set(relativePath, revision);
      return;
    }
    if (state.files.get(relativePath) === revision) return;
    state.files.set(relativePath, revision);
    state.version = ++versions;
  };

  const revision = Effect.fn("WorkspacePreviewRevisions.revision")(function* (
    document: PreviewDocument,
  ) {
    const key = documentKey(document);
    const state = documents.get(key) ?? {
      version: ++versions,
      overflowed: false,
      files: new Map<string, string | null>(),
      comparing: Semaphore.makeUnsafe(1),
    };
    documents.delete(key);
    documents.set(key, state);
    if (documents.size > MAX_TRACKED_DOCUMENTS) {
      for (const oldest of documents.keys()) {
        documents.delete(oldest);
        break;
      }
    }
    return yield* state.comparing.withPermits(1)(
      Effect.gen(function* () {
        const relativePaths = [...new Set([document.entryRelativePath, ...state.files.keys()])];
        const revisions = yield* Effect.forEach(
          relativePaths,
          (relativePath) => readFileRevision(path.join(document.workspaceRoot, relativePath)),
          { concurrency: REVISION_READ_CONCURRENCY },
        );
        for (const [index, relativePath] of relativePaths.entries()) {
          record(state, relativePath, revisions[index] ?? null);
        }
        return state.overflowed ? undefined : `${processId}:${state.version}`;
      }),
    );
  });

  const observe = Effect.fn("WorkspacePreviewRevisions.observe")(function* (
    document: PreviewDocument,
    relativePath: string,
  ) {
    // A document nobody minted here gets a new revision on its next mint, which reloads it.
    const state = documents.get(documentKey(document));
    if (state === undefined) return;
    yield* state.comparing.withPermits(1)(
      Effect.map(readFileRevision(path.join(document.workspaceRoot, relativePath)), (revision) =>
        record(state, relativePath, revision),
      ),
    );
  });

  return WorkspacePreviewRevisions.of({ revision, observe });
});

export const layer = Layer.effect(WorkspacePreviewRevisions, make);
