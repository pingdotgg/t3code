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
 * next one is fetched. The marks themselves are this environment's own rows and cost nothing to
 * read; this is the host call behind the **Changed** badge alone, so a held answer costs a badge
 * that is a minute behind rather than a stale tick.
 */
const FILE_REVISIONS_CACHE_TTL = Duration.seconds(60);
const FILE_REVISIONS_STALE_WINDOW = Duration.minutes(10);
export const FILE_REVISIONS_CACHE_CAPACITY = 64;

/**
 * How many paths one scope's entry carries. The count above bounds how many scopes are held, not
 * what any one of them holds: a reader ticking one file after another renews the same scope on
 * every press and adds a path to it each time, so a long review of a wide change request grows a
 * single entry without limit. Well over what a scope can report marks for, so a trim here only
 * ever reaches paths carried from earlier presses.
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
   * What the head has of the files a reader has marked, held between reads. A host says the empty
   * revision for a file the change request deletes, and leaves out a path it could not look at, so
   * the entry remembers what it has been asked as well as what it heard: a path asked for and
   * missing from an answer keeps whatever version was last given for it.
   */
  interface HeldFileRevisions {
    readonly at: number;
    readonly asked: ReadonlySet<string>;
    readonly revisions: ReadonlyMap<string, string>;
  }
  const heldFileRevisions = new Map<string, HeldFileRevisions>();
  const refreshingFileRevisions = new Set<string>();

  /**
   * Carries the reference's epoch like the read it serves, so whatever moved the head strands
   * what was held against the old one, including an answer still in flight, which stores under
   * the key it began with. Normalised, because a reference arrives spelled however the client
   * spelled it while the project carries the remote's own spelling.
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
        // Left out of the answer is the host not saying, not the head having nothing: the
        // version it last gave stands, since deleting it would turn a file reported as changed
        // back into a cleared one.
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
      // The entry is only as fresh as the oldest revision in it: stamping it with now would let
      // a reader ticking one new file after another carry the first file's revision past the point
      // it would have been read again, since every press renews the scope while asking one path.
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
   * What the head has of these files, or null where the host cannot say. Null is not an error:
   * without it the marks simply stop reporting staleness, which is worse than the host's own
   * record but better than refusing to remember anything.
   *
   * `held` answers from a value past its lifetime and fetches the next one off the critical path,
   * because a badge a moment behind beats a page of ticks that will not paint until a host answers.
   * `fresh` is for the press itself, which stamps what it stores and would otherwise write a
   * revision the head had already moved off.
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

// A plain factory rather than a `Context.Service`, against the preference in
// `.repos/effect-smol/LLMS.md`: the held revisions, the refresh set and the write gates are only
// correct at one instance per service, and a layer provided at two points in the graph would give
// two of each behind one epoch counter, which reads as a badge that is quietly wrong.
export const make = (dependencies: Dependencies) => {
  const { filesViewedStore, requireProject, requiredViewerOf, toPullRequestError } = dependencies;
  const { fileRevisionsOf } = makeFileRevisions(dependencies);
  /**
   * Which change request's marks, and whose. Provider and host lead the table's key because the
   * same repository exists on more than one install, and the reader is part of it for the reason a
   * host's own record is per-account. A host that names no reader is one reader, not none.
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
   * The marks this environment keeps for a host that keeps none of its own.
   *
   * A file the head still has at the revision it was cleared at is cleared; one the head has
   * moved on from is reported as changed, which is what GitHub says of a file pushed to since it
   * was ticked. Revisions are asked for the marked paths alone, so a reader who has marked
   * nothing costs no host call at all.
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
      // A host that will not say what its head has of a file costs the marks their staleness,
      // which is what `fileRevisionsOf` answers null for, rather than costing the reader every
      // tick they have made. Who the reader is, above, cannot give way like that: these rows are
      // keyed by it, so a lookup that failed is reported, and the client says the marks could not
      // be read rather than drawing a reader with marks as one with none.
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
          // A path the host had no answer for is one it could not look at, so the mark holds; a
          // file the change request deletes is answered as the empty revision, which is what its
          // mark was stamped with, so it is cleared once and stays cleared. A mark stamped with
          // no baseline holds for the same reason, until the reader presses it again.
          if (mark.revision === null) return { path: mark.path, state: "viewed" as const };
          const revision = revisions?.get(mark.path);
          return {
            path: mark.path,
            state:
              revision === undefined || revision === mark.revision
                ? ("viewed" as const)
                : ("dismissed" as const),
          };
        }),
        // The store carries a bounded number of marks per scope, so a reader who has ticked more
        // than that is short of some of them and told so, the same as a host-kept read that ran
        // out of pages.
        truncated: held.truncated,
      };
    });

  /**
   * One environment-backed write at a time per change request. A tick asks the host what it has
   * of the file before it stores anything and an untick asks nothing at all, so two presses in
   * quick succession would otherwise finish in the other order and leave the tick's row standing
   * over the untick that came after it.
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
              // A host that will not say what its head has, because it is backing off or because
              // the CLI is having a bad minute, costs the press its baseline rather than costing
              // the reader the press. The mark is stored with none, which holds until it is
              // pressed again: the file stops reporting staleness, and nothing is stamped with a
              // revision that was never read.
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
          // A path left out of the answer is the host declining to say, so the mark is stored
          // with no baseline rather than with the empty revision, which is an answer and would
          // report the file as changed the moment it turns out to have a version after all.
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
