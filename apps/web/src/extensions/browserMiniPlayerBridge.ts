import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { validateContext, type ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientBrowserMiniPlayer } from "@t3tools/extension-sdk/environment";
import {
  isPreviewSupportedInRuntime,
  previewStateAtom,
  readThreadPreviewState,
} from "../previewStateStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { readThreadShell } from "../state/entities";
import type { BrowserSurfaceBinding } from "./browserSurfaceBridge";

export function createBrowserMiniPlayerBridge(environmentId: EnvironmentId) {
  return (binding: BrowserSurfaceBinding): ClientBrowserMiniPlayer => {
    const target = (context: ViewContext) => {
      const resource = validateContext(context).resource;
      if (
        binding.lifetime.aborted ||
        resource.environmentId !== environmentId ||
        !resource.threadId ||
        !binding.grants.capabilities.includes("t3.ui/panels")
      )
        return null;
      if (!resource.projectId || !binding.grants.projectIds.includes(resource.projectId))
        return null;
      return scopeThreadRef(environmentId, ThreadId.make(resource.threadId));
    };
    const scope = (context: ViewContext) => {
      const candidate = target(context);
      if (!candidate) return null;
      const resource = context.resource;
      return readThreadShell(candidate)?.projectId === resource.projectId ? candidate : null;
    };
    return {
      version: 1,
      supported: isPreviewSupportedInRuntime(),
      read: (context) => {
        const ref = scope(context);
        return ref
          ? selectThreadPreviewMiniPlayerTabId(
              usePreviewMiniPlayerStore.getState().byThreadKey,
              ref,
            )
          : null;
      },
      canFloat: (context, session) => {
        const ref = scope(context);
        if (!ref) return false;
        const state = readThreadPreviewState(ref);
        return (
          state.serverEpoch === session.serverEpoch &&
          !!state.desktopByTabId[session.tabId]?.hasWebContents &&
          state.sessions[session.tabId]?.navStatus._tag !== "LoadFailed"
        );
      },
      subscribe: (context, listener) => {
        const ref = target(context);
        if (!ref) return () => {};
        const unsubscribe = usePreviewMiniPlayerStore.subscribe(listener);
        const unsubscribePreview = appAtomRegistry.subscribe(
          previewStateAtom(scopedThreadKey(ref)),
          listener,
        );
        const dispose = () => {
          unsubscribe();
          unsubscribePreview();
          binding.lifetime.removeEventListener("abort", dispose);
        };
        binding.lifetime.addEventListener("abort", dispose, { once: true });
        return dispose;
      },
    };
  };
}
