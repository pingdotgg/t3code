import type {
  EnvironmentId,
  OrchestrationV2HandoffBundleV1,
  OrchestrationV2HandoffPart,
  ProjectId,
  ThreadHandoffId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import {
  abortThreadHandoff,
  completeThreadHandoff,
  departThread,
  prepareThreadHandoff,
  receiveThreadHandoff,
} from "../operations/threadHandoff.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { readHandoffPartChunk, writeHandoffPartChunk } from "./handoffPartsHttp.ts";
import { runInEnvironment } from "./runtime.ts";

/**
 * The steps of a hop, in the order they happen.
 *
 * The split matters for what a user is allowed to do: everything up to and
 * including `upload` has changed nothing on either machine, so cancelling is
 * free. From `apply` onward the receiving repository is being written to, and
 * only the servers can put it back.
 */
export type ThreadHandoffPhase = "prepare" | "depart" | "upload" | "apply" | "settle";

export interface ThreadHandoffProgress {
  readonly phase: ThreadHandoffPhase;
  readonly transferredBytes: number;
  readonly totalBytes: number;
}

export interface ThreadHandoffTransferInput {
  readonly threadId: ThreadId;
  readonly originEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string | null;
  /** Null when the destination lacks the repository and must clone it. */
  readonly targetProjectId: ProjectId | null;
  /** Where the destination should clone when it lacks the repository. */
  readonly cloneWorkspaceRoot: string | null;
  /** Set when the hop returns to a thread the target already owns. */
  readonly returningThreadId: ThreadId | null;
  /** The target's tip for this branch, so the bundle carries only what it lacks. */
  readonly targetBranchTip: string | null;
  readonly previousHandoffId: ThreadHandoffId | null;
  readonly hopCount: number;
  readonly originConnection: PreparedConnection;
  readonly targetConnection: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly onProgress?: (progress: ThreadHandoffProgress) => void;
}

export interface ThreadHandoffTransferResult {
  readonly handoffId: ThreadHandoffId;
  readonly targetThreadId: ThreadId;
}

/**
 * Copies one part across, a chunk at a time.
 *
 * The receiving side rejects a chunk that does not continue exactly where the
 * staged bytes end, so the offset the reader reports is the only thing that
 * decides where a write lands — a retried or reordered chunk cannot punch a
 * hole in the part.
 */
const copyPart = Effect.fn("clientRuntime.state.copyHandoffPart")(function* (input: {
  readonly part: OrchestrationV2HandoffPart;
  readonly handoffId: ThreadHandoffId;
  readonly origin: ThreadHandoffTransferInput["originConnection"];
  readonly target: ThreadHandoffTransferInput["targetConnection"];
  readonly signer: ThreadHandoffTransferInput["signer"];
  readonly onChunk: (bytes: number) => void;
}) {
  let offset = 0;
  let complete = false;
  while (!complete) {
    const chunk = yield* readHandoffPartChunk({
      prepared: input.origin,
      signer: input.signer,
      handoffId: input.handoffId,
      kind: input.part.kind,
      offset,
    });
    if (chunk.data.length > 0) {
      yield* writeHandoffPartChunk({
        prepared: input.target,
        signer: input.signer,
        handoffId: input.handoffId,
        kind: input.part.kind,
        offset: chunk.offset,
        data: chunk.data,
      });
      input.onChunk(chunk.data.length);
    }
    offset = chunk.offset + chunk.data.length;
    complete = chunk.complete;
  }
});

/**
 * Runs one hop end to end across two environments.
 *
 * The order is the safety model: stage, lock the giving side, move the bytes,
 * apply, then record where the thread went. Locking before the bytes move is
 * what guarantees the two sides can never both be live; anything that fails
 * after the lock releases it, so a failed transfer leaves the thread usable
 * where it started rather than stranded.
 */
export const runThreadHandoffTransfer = Effect.fn("clientRuntime.state.runThreadHandoffTransfer")(
  function* (input: ThreadHandoffTransferInput) {
    const report = (phase: ThreadHandoffPhase, transferredBytes: number, totalBytes: number) => {
      // A throwing progress callback must never look like a transfer failure:
      // past the receive step that would release the origin lock while the
      // target is already live.
      try {
        input.onProgress?.({ phase, transferredBytes, totalBytes });
      } catch {
        // Progress is cosmetic; the transfer's own state is authoritative.
      }
    };

    report("prepare", 0, 0);
    const preparation = yield* runInEnvironment(
      input.originEnvironmentId,
      prepareThreadHandoff({
        threadId: input.threadId,
        peerEnvironmentId: input.targetEnvironmentId,
        peerBranchTip: input.targetBranchTip,
        // No project on the destination means it will clone from the bundle,
        // which only works when the bundle carries the whole history.
        fullHistory: input.targetProjectId === null,
        previousHandoffId: input.previousHandoffId,
        hopCount: input.hopCount,
      }),
    );
    const bundle: OrchestrationV2HandoffBundleV1 = preparation.bundle;
    const totalBytes = preparation.totalBytes;

    // From here on the thread is locked, so every failure has to release it
    // before surfacing — otherwise a transient network error would leave a
    // thread nobody can type in on either machine.
    const release = (reason: "transfer failed" | "transfer cancelled") =>
      runInEnvironment(
        input.originEnvironmentId,
        abortThreadHandoff({
          threadId: input.threadId,
          handoffId: bundle.handoffId,
          reason,
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `thread handoff abort failed handoffId=${bundle.handoffId} environmentId=${input.originEnvironmentId}`,
            cause,
          ),
        ),
      );

    report("depart", 0, totalBytes);
    // The lock can be taken server-side and the response still be lost, so a
    // failed depart also tries to release before surfacing.
    yield* runInEnvironment(
      input.originEnvironmentId,
      departThread({
        threadId: input.threadId,
        handoffId: bundle.handoffId,
        peerEnvironmentId: input.targetEnvironmentId,
        peerLabel: input.targetLabel,
        previousHandoffId: input.previousHandoffId,
        hopCount: input.hopCount,
      }),
    ).pipe(Effect.tapCause(() => release("transfer failed")));

    // Once the destination has applied the bundle, releasing here would make
    // both sides live. Past that point failures surface with the depart lock
    // still held, which "Continue here" or the next pull can recover.
    let received = false;

    return yield* Effect.gen(function* () {
      let transferred = 0;
      report("upload", transferred, totalBytes);
      for (const part of bundle.parts) {
        yield* copyPart({
          part,
          handoffId: bundle.handoffId,
          origin: input.originConnection,
          target: input.targetConnection,
          signer: input.signer,
          onChunk: (bytes) => {
            transferred += bytes;
            report("upload", transferred, totalBytes);
          },
        });
      }

      report("apply", transferred, totalBytes);
      const application = yield* runInEnvironment(
        input.targetEnvironmentId,
        receiveThreadHandoff({
          bundle,
          projectId: input.targetProjectId,
          cloneWorkspaceRoot: input.cloneWorkspaceRoot,
          returningThreadId: input.returningThreadId,
        }),
      );
      received = true;

      yield* runInEnvironment(
        input.originEnvironmentId,
        completeThreadHandoff({
          threadId: input.threadId,
          handoffId: bundle.handoffId,
          peerThreadId: application.threadId,
        }),
      ).pipe(Effect.retry({ times: 1 }));
      report("settle", transferred, totalBytes);

      return {
        handoffId: bundle.handoffId,
        targetThreadId: application.threadId,
      } satisfies ThreadHandoffTransferResult;
    }).pipe(
      Effect.tapCause(() => (received ? Effect.void : release("transfer failed"))),
      Effect.onInterrupt(() => (received ? Effect.void : release("transfer cancelled"))),
    );
  },
);
