import { useAtomValue } from "@effect/atom-react";
import { PREVIEW_STREAM_BASE_PATH } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { engineEnvironmentIdAtom } from "../state/projects";
import { environmentSession } from "../state/server";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

/** The stream's address and the media ticket that authorizes its WebSocket, which expires and is minted again on refresh. */
export const previewStreamAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PREVIEW_STREAM_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`board-preview-stream-access:${environmentId}`)),
);

export function usePreviewStreamAccess(environmentId: EnvironmentId): DeviceHubAccess | null {
  const result = useAtomValue(previewStreamAccessAtom(environmentId));
  return AsyncResult.isSuccess(result) ? result.value : null;
}

const NO_SESSIONS: ReadonlyArray<PreviewSessionSnapshot> = [];

/** The browser tabs one thread holds in the engine. They exist whether or not the board was looking, so the list is read, then read again when the engine reports a tab opening, navigating, or closing. */
export const threadSessionsAtom = Atom.family((threadId: string) =>
  Atom.make((get): ReadonlyArray<PreviewSessionSnapshot> => {
    const environmentId = get(engineEnvironmentIdAtom);
    if (environmentId === null) return NO_SESSIONS;
    const list = previewEnvironment.list({
      environmentId,
      input: { threadId: ThreadId.make(threadId) },
    });
    get.subscribe(previewEnvironment.events({ environmentId, input: {} }), (event) => {
      if (AsyncResult.isSuccess(event) && event.value.threadId === threadId) get.refresh(list);
    });
    const result = get(list);
    return AsyncResult.isSuccess(result) ? result.value.sessions : NO_SESSIONS;
  }).pipe(Atom.withLabel(`board-preview-sessions:${threadId}`)),
);
