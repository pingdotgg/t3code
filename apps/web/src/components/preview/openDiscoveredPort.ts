import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { acquireDiscoveredServerRoute } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";

export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  try {
    const route = await acquireDiscoveredServerRoute(input.threadRef.environmentId, input.port.url);
    try {
      const result = await openPreviewSession({
        openPreview: input.openPreview,
        threadRef: input.threadRef,
        url: route.resolution.resolvedUrl,
      });
      if (result._tag === "Success") {
        await route.commit(result.value.tabId);
      }
      return mapAtomCommandResult(result, (snapshot) => {
        useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
      });
    } finally {
      await route.release();
    }
  } catch (cause) {
    return AsyncResult.failure(Cause.die(cause));
  }
}
