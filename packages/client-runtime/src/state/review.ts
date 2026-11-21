import {
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  VcsUnsupportedOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { request } from "../rpc/client.ts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  type QueryAnswerHandler,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

interface PreviewRevisionState {
  readonly key: string | null;
  /** When the preview's pending read was first seen; set only while it waits. */
  readonly requestedAt: number | undefined;
  /** The revision patches are read under. */
  readonly revision: string | null;
}

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly onDiffPreviewAnswer?: QueryAnswerHandler<
      ReviewDiffPreviewInput,
      ReviewDiffPreviewResult
    >;
  } = {},
) {
  const patchReads = Semaphore.makeUnsafe(4);
  const diffFileScheduler = createAtomCommandScheduler();
  const diffPreview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:review:diff-preview",
    tag: WS_METHODS.reviewGetDiffPreview,
    staleTimeMs: 5_000,
    execute: Effect.fn("review.diffPreview")(function* (
      input: ReviewDiffPreviewInput,
      emit: (value: ReviewDiffPreviewResult) => Effect.Effect<void>,
      previous: Option.Option<ReviewDiffPreviewResult>,
    ) {
      const hasCompletePreview = Option.exists(previous, (preview) => !preview.incomplete);
      if (
        !hasCompletePreview &&
        input.sourceKind &&
        !input.file &&
        !input.commitSha &&
        !input.trackedOnly
      ) {
        const tracked = yield* request(WS_METHODS.reviewGetDiffPreview, {
          ...input,
          trackedOnly: true,
        });
        // Older servers ignore trackedOnly and already return the complete preview.
        if (!tracked.incomplete) return tracked;
        yield* emit(tracked);
        if (tracked.completionToken !== undefined) {
          return yield* request(WS_METHODS.reviewGetDiffPreview, {
            ...input,
            completionToken: tracked.completionToken,
          });
        }
      }
      return yield* request(WS_METHODS.reviewGetDiffPreview, input);
    }),
    ...(options.onDiffPreviewAnswer === undefined ? {} : { onAnswer: options.onDiffPreviewAnswer }),
  });
  // A file patch is a slice of the comparison its preview generated, so a preview revision
  // requested after the patch was read makes it stale. A read that overlaps the revision's own
  // read, such as the Diff panel's patches requested as it revalidates on show, is as fresh as it.
  const previewRevision = (
    target: Parameters<typeof diffPreview>[0],
    patch: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    // Held outside the node so a swept and rebuilt node does not report a revision change.
    const states = new WeakMap<AtomRegistry.AtomRegistry, PreviewRevisionState>();
    return Atom.make((get) => {
      // Reading the preview here keeps its query mounted while any of its patches is read.
      const result = get(diffPreview(target));
      // A failed refresh keeps the last revision, so an error does not refresh every patch.
      const key = Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (preview) => DateTime.formatIso(preview.generatedAt),
      });
      const previous = states.get(get.registry);
      const requestedAt = result.waiting
        ? // @effect-diagnostics-next-line globalDate:off - Compared with `AsyncResult` timestamps, which come from `Date.now`.
          (previous?.requestedAt ?? Date.now())
        : undefined;
      let revision = key;
      if (previous !== undefined && key === previous.key) revision = previous.revision;
      else if (previous !== undefined) {
        const since = requestedAt ?? previous.requestedAt;
        const read = get.once(patch);
        const fresh =
          since !== undefined &&
          (read.waiting || (read._tag === "Success" && read.timestamp >= since));
        if (fresh) revision = previous.revision;
      }
      states.set(get.registry, { key, requestedAt, revision });
      return revision;
    });
  };
  return {
    branchCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:branch-commits",
      tag: WS_METHODS.reviewGetBranchCommits,
      staleTimeMs: 5_000,
    }),
    diffPreview,
    diffFilePatch: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-file-patch",
      staleTimeMs: 5 * 60_000,
      refreshTrigger: ({ environmentId, input }, patch) =>
        input.preview === undefined
          ? undefined
          : previewRevision({ environmentId, input: input.preview }, patch),
      execute: (input: {
        request: ReviewDiffPreviewInput & { file: NonNullable<ReviewDiffPreviewInput["file"]> };
        cacheKey: string;
        /** The preview this patch belongs to; its revisions refresh the patch. */
        preview?: ReviewDiffPreviewInput;
      }) =>
        request(WS_METHODS.reviewGetDiffPreview, input.request).pipe(
          patchReads.withPermit,
          Effect.flatMap((result) => {
            const source = result.sources.find(
              (source) => source.kind === input.request.file.sourceKind,
            );
            return source
              ? Effect.succeed(source)
              : Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "review.diffFilePatch",
                    kind: "git",
                    detail: "Diff no longer available. Refresh the comparison.",
                  }),
                );
          }),
        ),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:diff-file-contents",
      tag: WS_METHODS.reviewGetDiffFileContents,
      scheduler: diffFileScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.cwd,
            input.sourceKind,
            input.baseRef,
            input.headRef,
            input.oldPath,
            input.newPath,
            input.changeType,
          ]),
      },
    }),
  };
}
