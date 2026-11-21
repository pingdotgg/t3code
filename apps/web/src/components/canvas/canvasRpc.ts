import { subscribe } from "@t3tools/client-runtime/rpc";
import { followStreamInEnvironment, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type CanvasDocumentEvent,
  type CanvasHostRegistration,
  type CanvasHostStreamEvent,
  type CanvasOp,
  type EnvironmentId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { canvasEnvironment } from "~/state/canvas";

export function sendCanvasOps(
  environmentId: EnvironmentId,
  documentId: string,
  ops: ReadonlyArray<CanvasOp>,
  clientBatchId: string,
) {
  return runAtomCommand(
    appAtomRegistry,
    canvasEnvironment.applyOps,
    { environmentId, input: { documentId, ops: [...ops], clientBatchId } },
    { reportFailure: false },
  );
}

/** Refetches a project's canvas list after this client creates or deletes one. */
export function refreshCanvasList(environmentId: EnvironmentId, projectId: ProjectId) {
  appAtomRegistry.refresh(canvasEnvironment.list({ environmentId, input: { projectId } }));
}

// Both follows run the stream for its side effects so every event reaches the
// callback; an atom holding the stream's latest value keeps only the last
// event of a burst, which would drop op batches and host requests.

/** A snapshot first (again after every reconnect), then op batches. */
export function followCanvasDocument(
  environmentId: EnvironmentId,
  documentId: string,
  onEvent: (event: CanvasDocumentEvent) => void,
  onFailure: () => void,
): () => void {
  const stream = followStreamInEnvironment(
    environmentId,
    subscribe(WS_METHODS.canvasSubscribe, { documentId }),
  );
  return appAtomRegistry.mount(
    connectionAtomRuntime.atom(
      Stream.runForEach(stream, (event) => Effect.sync(() => onEvent(event))).pipe(
        Effect.catchCause(() => Effect.sync(onFailure)),
      ),
    ),
  );
}

/** Screenshot and open requests the server routes to this client. */
export function followCanvasHostRequests(
  environmentId: EnvironmentId,
  registration: CanvasHostRegistration,
  onEvent: (event: CanvasHostStreamEvent) => void,
): () => void {
  const stream = followStreamInEnvironment(
    environmentId,
    subscribe(WS_METHODS.canvasConnectHost, registration),
  );
  return appAtomRegistry.mount(
    connectionAtomRuntime.atom(
      Stream.runForEach(stream, (event) => Effect.sync(() => onEvent(event))),
    ),
  );
}
