/**
 * The marks a reader has ticked off, for a host that keeps none of its own, and the held record of
 * what the head has of those files. The revisions cache is filed here because this is its only
 * consumer: when a second one appears, export `makeFileRevisions` and split it into its own file.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  PullRequestOperationError,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
  type PullRequestSetFilesViewedInput,
} from "@t3tools/contracts";

import type * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import type { PullRequestProviderError } from "./PullRequestProvider.ts";
import type { PullRequestError, SupportedProject } from "./PullRequestService.ts";

/**
 * How long the head's version of a file is believed, and how long a held answer stands while the
 * next one is fetched. This is the host call behind the **Changed** badge alone, so a held answer
 * costs a badge that is a minute behind rather than a stale tick.
 */
const FILE_REVISIONS_CACHE_TTL = Duration.seconds(60);
const FILE_REVISIONS_STALE_WINDOW = Duration.minutes(10);
export const FILE_REVISIONS_CACHE_CAPACITY = 64;

/**
 * How many paths one scope's entry carries. Bounds a single scope, not how many scopes are held:
 * a reader ticking one file after another renews the same scope and grows it without limit
 * otherwise.
 */
export const MAX_FILE_REVISION_PATHS = 1_000;

interface FileRevisionsDependencies {
  readonly runFork: (effect: Effect.Effect<void>) => unknown;
  readonly refEpoch: (ref: PullRequestRef) => number;
  readonly fileRevisionsEpoch: () => number;
  readonly toPullRequestError: (
    operation: string,
  ) => (error: PullRequestProviderError) => PullRequestError;
}

const makeFileRevisions = (dependencies: FileRevisionsDependencies) => {
  const { runFork, refEpoch, fileRevisionsEpoch, toPullRequestError } = dependencies;
  /**
   * What the head has of the files a reader has marked, held between reads. The entry tracks what
   * has been asked as well as what was heard, since a path missing from an answer keeps whatever
   * version was last given for it rather than being cleared.
   */
  interface HeldFileRevisions {
    readonly at: number;
    readonly asked: ReadonlySet<string>;
    readonly revisions: ReadonlyMap<string, string>;
  }
  const heldFileRevisions = new Map<string, HeldFileRevisions>();
  const refreshingFileRevisions = new Set<string>();

  /**
   * Carries the reference's epoch, so whatever moved the head strands what was held (or in
   * flight) against the old one. Normalised, since a reference arrives spelled however the
   * client spelled it while the project carries the remote's own spelling.
   */
  const fileRevisionsKey = (ref: PullRequestRef) =>
    [
      refEpoch(ref),
      fileRevisionsEpoch(),
      ref.projectId,
      ref.repository.trim().toLowerCase(),
      ref.number,
    ].join(" ");

  const recordFileRevisions = (
    key: string,
    paths: ReadonlyArray<string>,
    answer: ReadonlyMap<string, string>,
  ) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      const held = heldFileRevisions.get(key);
      // Past the stale window the old entry is not worth merging into: it would carry paths
      // nobody has asked about since, at revisions the head has long moved off.
      const carried =
        held !== undefined && at - held.at <= Duration.toMillis(FILE_REVISIONS_STALE_WINDOW)
          ? held
          : null;
      const revisions = new Map(carried?.revisions ?? []);
      const asked = new Set(carried?.asked ?? []);
      for (const path of paths) {
        // Reinserted rather than added, so what a full entry drops below is the path nobody has
        // asked about in the longest rather than one just asked for.
        asked.delete(path);
        asked.add(path);
        const revision = answer.get(path);
        // A path left out of the answer keeps its last known version rather than being cleared.
        if (revision !== undefined) {
          revisions.delete(path);
          revisions.set(path, revision);
        }
      }
      for (const path of asked) {
        if (asked.size <= MAX_FILE_REVISION_PATHS) break;
        asked.delete(path);
        revisions.delete(path);
      }
      heldFileRevisions.delete(key);
      if (heldFileRevisions.size >= FILE_REVISIONS_CACHE_CAPACITY) {
        const oldest = heldFileRevisions.keys().next().value;
        if (oldest !== undefined) heldFileRevisions.delete(oldest);
      }
      // The entry is only as fresh as its oldest revision: stamping it with `now` on a partial
      // answer would let an old revision ride past the point it should have been re-read.
      const stamped = [...revisions.keys()].every((path) => answer.has(path))
        ? at
        : (carried?.at ?? at);
      heldFileRevisions.set(key, { at: stamped, asked, revisions });
      return revisions;
    });

  /** A held entry that covers every path asked for and is still worth answering from. */
  const heldFileRevisionsFor = (key: string, paths: ReadonlyArray<string>, now: number) => {
    const held = heldFileRevisions.get(key);
    if (held === undefined) return null;
    // Put back at the end on every read, so the scope a reader is working through is not the one
    // evicted by a listing walking scopes nobody has open.
    heldFileRevisions.delete(key);
    heldFileRevisions.set(key, held);
    if (now - held.at > Duration.toMillis(FILE_REVISIONS_STALE_WINDOW)) return null;
    return paths.every((path) => held.asked.has(path)) ? held : null;
  };

  /**
   * What the head has of these files, or null where the host cannot say (not an error: the marks
   * just stop reporting staleness). `held` answers from a stale value and refetches off the
   * critical path, since a badge a moment behind beats a page that won't paint until the host
   * answers; `fresh` is for the press itself, which must not store a revision the head already
   * moved off.
   */
  const fileRevisionsOf = (
    project: SupportedProject,
    ref: PullRequestRef,
    paths: ReadonlyArray<string>,
    operation: string,
    freshness: "held" | "fresh" = "held",
  ): Effect.Effect<ReadonlyMap<string, string> | null, PullRequestError> => {
    const read = project.api.getFileRevisions;
    if (read === undefined) return Effect.succeed(null);
    // Suspended, so a held answer costs the host nothing: a provider is free to do its work as
    // the request is built rather than as the effect is run.
    const fetch = Effect.suspend(() => {
      const key = fileRevisionsKey(ref);
      return read({
        cwd: project.project.workspaceRoot,
        repository: project.repository,
        host: project.host,
        number: ref.number,
        paths,
      }).pipe(
        Effect.mapError(toPullRequestError(operation)),
        Effect.flatMap((answer) => recordFileRevisions(key, paths, answer.revisions)),
      );
    });
    return Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const key = fileRevisionsKey(ref);
      const held = heldFileRevisionsFor(key, paths, now);
      if (held === null) return fetch;
      if (now - held.at <= Duration.toMillis(FILE_REVISIONS_CACHE_TTL))
        return Effect.succeed(held.revisions);
      if (freshness === "fresh") return fetch;
      if (refreshingFileRevisions.has(key)) return Effect.succeed(held.revisions);
      // Its own fiber rather than a child: the caller has been answered and is gone before this
      // lands. One at a time per change request, so a page of files costs one host read.
      return Effect.sync(() => {
        refreshingFileRevisions.add(key);
        runFork(
          Effect.ignore(fetch).pipe(
            Effect.ensuring(Effect.sync(() => refreshingFileRevisions.delete(key))),
          ),
        );
      }).pipe(Effect.as(held.revisions));
    });
  };

  return { fileRevisionsOf } as const;
};

export interface Dependencies extends FileRevisionsDependencies {
  readonly filesViewedStore: PullRequestFilesViewed.PullRequestFilesViewedRepository["Service"];
  readonly requireProject: (
    ref: PullRequestRef,
  ) => Effect.Effect<SupportedProject, PullRequestError>;
  readonly requiredViewerOf: (
    project: SupportedProject,
    operation: string,
  ) => Effect.Effect<string | null, PullRequestError>;
}

// A plain factory rather than a `Context.Service` (against the preference in
// `.repos/effect-smol/LLMS.md`): the held revisions, refresh set, and write gates are only correct
// at one instance per service, and a layer provided at two points would give two of each behind
// one epoch counter.
export const make = (dependencies: Dependencies) => {
  const { filesViewedStore, requireProject, requiredViewerOf, toPullRequestError } = dependencies;
  const { fileRevisionsOf } = makeFileRevisions(dependencies);
  /**
   * Which change request's marks, and whose. Provider and host lead the key because the same
   * repository can exist on more than one install; the reader is part of it because a host's own
   * record is per-account. A host that names no reader is one reader, not none.
   */
  const filesViewedScope = (project: SupportedProject, number: number, viewer: string | null) => ({
    provider: project.api.kind,
    host: project.host,
    repository: project.remote,
    number,
    viewer: viewer ?? "",
  });

  const toFilesViewedStoreError = (operation: string) => (cause: unknown) =>
    new PullRequestOperationError({
      operation,
      detail: "This environment could not reach its record of which files you have seen.",
      cause,
    });

  /**
   * The marks this environment keeps for a host that keeps none of its own. A file the head
   * still has at the revision it was cleared at is cleared; one the head has moved on from is
   * reported as changed. Revisions are asked for the marked paths alone, so a reader who has
   * marked nothing costs no host call.
   */
  const environmentFilesViewed = (
    project: SupportedProject,
    ref: PullRequestRef,
  ): Effect.Effect<PullRequestFilesViewedResult, PullRequestError> =>
    Effect.gen(function* () {
      const viewer = yield* requiredViewerOf(project, "filesViewed");
      const held = yield* filesViewedStore
        .list(filesViewedScope(project, ref.number, viewer))
        .pipe(Effect.mapError(toFilesViewedStoreError("filesViewed")));
      const marks = held.files;
      if (marks.length === 0) return { files: [], truncated: held.truncated };
      // A host that won't say what its head has costs the marks their staleness (`fileRevisionsOf`
      // returns null), rather than costing the reader every tick they've made.
      const revisions = yield* fileRevisionsOf(
        project,
        ref,
        marks.map((mark) => mark.path),
        "filesViewed",
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("reporting viewed files without what the head has of them", {
            operation: "filesViewed",
            reason: error._tag,
          }).pipe(Effect.as(null)),
        ),
      );
      return {
        files: marks.map((mark) => {
          // A mark stamped with no baseline holds until the reader presses it again.
          if (mark.revision === null) return { path: mark.path, state: "viewed" as const };
          const revision = revisions?.get(mark.path);
          // A deleted file is answered as the empty revision, matching its stamp, so it stays
          // cleared; a path the host had no answer for (`undefined`) also holds as cleared.
          return {
            path: mark.path,
            state:
              revision === undefined || revision === mark.revision
                ? ("viewed" as const)
                : ("dismissed" as const),
          };
        }),
        // The store caps marks per scope; a reader over that cap is told so, like a paginated read.
        truncated: held.truncated,
      };
    });

  /**
   * One environment-backed write at a time per change request. A tick's host round trip is
   * slower than an untick's, so unordered presses could finish out of order and leave a stale
   * tick standing over a later untick.
   */
  const filesViewedGates = new Map<
    string,
    { readonly gate: Semaphore.Semaphore; pending: number }
  >();

  const inFilesViewedOrder = (
    project: SupportedProject,
    number: number,
    write: Effect.Effect<void, PullRequestError>,
  ) =>
    // Suspended rather than generated, so finding the gate, putting it in and taking a place in
    // its queue are one step: yielding for `Semaphore.make` between the lookup and the insert
    // lets two presses each make a gate of their own and neither wait on the other.
    Effect.suspend(() => {
      const key = `${project.project.id} ${project.remote} ${number}`;
      const held = filesViewedGates.get(key);
      const entry = held ?? { gate: Semaphore.makeUnsafe(1), pending: 0 };
      if (held === undefined) filesViewedGates.set(key, entry);
      entry.pending += 1;
      // Dropped once nobody is queued behind it, so a long-lived server does not keep a gate per
      // change request anyone has ever ticked a file in.
      return entry.gate
        .withPermits(1)(write)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.pending -= 1;
              if (entry.pending === 0) filesViewedGates.delete(key);
            }),
          ),
        );
    });

  const environmentSetFilesViewed = (
    project: SupportedProject,
    input: PullRequestSetFilesViewedInput,
  ): Effect.Effect<void, PullRequestError> =>
    Effect.gen(function* () {
      const viewer = yield* requiredViewerOf(project, "setFilesViewed");
      // Only the files being cleared need a revision. An unticked one is about to lose its row,
      // and what the head has of it changes nothing about deleting it.
      const cleared = input.files.filter((file) => file.viewed).map((file) => file.path);
      const revisions =
        cleared.length === 0
          ? null
          : yield* fileRevisionsOf(project, input, cleared, "setFilesViewed", "fresh").pipe(
              // A host that won't say what its head has costs the press its baseline, not the
              // press itself: the mark is stored with none and holds until pressed again.
              Effect.catch((error) =>
                Effect.logWarning("recording viewed files without what the head has of them", {
                  operation: "setFilesViewed",
                  reason: error._tag,
                }).pipe(Effect.as(null)),
              ),
            );
      const viewedAt = DateTime.formatIso(yield* DateTime.now);
      yield* filesViewedStore
        .set({
          ...filesViewedScope(project, input.number, viewer),
          // A path left out of the answer stores with no baseline, not the empty revision, since
          // the empty revision is itself an answer and would misreport the file once it turns
          // out to have a version after all.
          files: input.files.map((file) => ({
            path: file.path,
            revision: revisions?.get(file.path) ?? null,
            viewed: file.viewed,
          })),
          viewedAt,
        })
        .pipe(Effect.mapError(toFilesViewedStoreError("setFilesViewed")));
    });

  const filesViewed = (input: PullRequestRef) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<PullRequestFilesViewedResult, PullRequestError> => {
        const read = project.api.getFilesViewed;
        if (project.api.capabilities.viewedFiles === "host" && read) {
          return read({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
          }).pipe(Effect.mapError(toPullRequestError("filesViewed")));
        }
        if (project.api.capabilities.viewedFiles === "environment") {
          return environmentFilesViewed(project, input);
        }
        return Effect.fail(
          new PullRequestOperationError({
            operation: "filesViewed",
            detail: "This host does not track which files a reader has seen.",
          }),
        );
      }),
    );

  const setFilesViewed = (
    input: PullRequestSetFilesViewedInput,
  ): Effect.Effect<void, PullRequestError> =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const write = project.api.setFilesViewed;
        if (project.api.capabilities.viewedFiles === "host" && write) {
          return write({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            files: input.files,
          }).pipe(Effect.mapError(toPullRequestError("setFilesViewed")));
        }
        if (project.api.capabilities.viewedFiles === "environment") {
          return inFilesViewedOrder(
            project,
            input.number,
            environmentSetFilesViewed(project, input),
          );
        }
        return Effect.fail(
          new PullRequestOperationError({
            operation: "setFilesViewed",
            detail: "This host does not track which files a reader has seen.",
          }),
        );
      }),
    );

  return { filesViewed, setFilesViewed };
};
