import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { MirrorService } from "../../mirror/MirrorService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  MirrorProjectDeletionReactor,
  type MirrorProjectDeletionReactorShape,
} from "../Services/MirrorProjectDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ProjectDeletedEvent = Extract<OrchestrationEvent, { type: "project.deleted" }>;

/**
 * Revoke a deleted project's mirror link and every mirror-peer credential
 * for it. Exported standalone (rather than only as an inner closure) so it
 * can be exercised directly in tests, without standing up the full
 * reactor's stream/worker plumbing.
 */
export const revokeMirrorLinkAndCredentials = Effect.fn("revokeMirrorLinkAndCredentials")(
  function* (projectId: ProjectDeletedEvent["payload"]["projectId"]) {
    const mirrorService = yield* MirrorService;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    // Unconditional: by the time this event lands the project is already
    // soft-deleted, so isMirroredProject would always read false (it
    // excludes deleted rows) and could never gate this call. revokeLink is
    // a no-op for a project that was never mirrored.
    yield* mirrorService.revokeLink(projectId);
    // revokeLink only best-effort notifies a *connected* origin and drops
    // the host-side watermark; it never invalidates the credential. Without
    // this, a disconnected origin's mirror-peer token stays live forever
    // and can still authenticate after the project is gone.
    const peerSubject = `mirror-peer:${projectId}`;
    const existingSessions = yield* serverAuth.listSessions();
    yield* Effect.forEach(
      existingSessions.filter((session) => session.subject === peerSubject),
      (session) => serverAuth.revokeSession(session.sessionId),
      { discard: true },
    );
  },
);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;

  const processProjectDeleted = (event: ProjectDeletedEvent) =>
    revokeMirrorLinkAndCredentials(event.payload.projectId);

  const processProjectDeletedSafely = (event: ProjectDeletedEvent) =>
    processProjectDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("mirror project deletion reactor failed to process event", {
          eventType: event.type,
          projectId: event.payload.projectId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processProjectDeletedSafely);

  const start: MirrorProjectDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "project.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies MirrorProjectDeletionReactorShape;
});

export const MirrorProjectDeletionReactorLive = Layer.effect(MirrorProjectDeletionReactor, make);
