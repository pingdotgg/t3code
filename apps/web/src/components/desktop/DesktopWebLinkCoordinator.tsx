import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { openFileInPreview, openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * The thread on screen when its browser panel is showing, so a link opens as
 * another tab there, the way a browser window takes new links. HTML files are
 * served by this machine's environment, so only its threads can take them.
 */
function threadShowingBrowser(
  routeParams: Record<string, string | undefined>,
  fileEnvironmentId: EnvironmentId | null,
): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(routeParams);
  if (target === null) return null;
  let threadRef = target.kind === "server" ? target.threadRef : null;
  if (target.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
    if (!session || session.promotedTo) return null;
    threadRef = scopeThreadRef(session.environmentId, session.threadId);
  }
  if (threadRef === null || !isPreviewAvailableFor(threadRef.environmentId)) return null;
  if (fileEnvironmentId !== null && threadRef.environmentId !== fileEnvironmentId) return null;
  const surface = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  return surface?.kind === "preview" ? threadRef : null;
}

/**
 * Opens each web link or HTML file the OS hands T3 Code as the default browser
 * (macOS). With a browser panel on screen the page opens as a new tab there;
 * otherwise it starts a thread without a project, its browser panel maximized.
 */
export function DesktopWebLinkCoordinator() {
  const router = useRouter();
  const primaryEnvironment = usePrimaryEnvironment();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironment?.environmentId ?? null);
  const queueRef = useRef(Promise.resolve());
  const webLinks = window.desktopBridge?.webLinks;
  const ready =
    webLinks !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null;

  const reportFailure = (url: string, description = url) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not open the link", description }),
    );

  // The OS hands each link over once, so a thread that could not start says so.
  const startThread = async (url: string): Promise<ScopedThreadRef | null> => {
    const environmentId = scratchEnvironmentId(primaryEnvironment?.environmentId ?? null);
    if (environmentId === null) {
      reportFailure(url);
      return null;
    }
    // Reports its own failure.
    const project = await openScratchProject(environmentId, "Could not open the link");
    if (!project) return null;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) {
      reportFailure(url);
      return null;
    }
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    return threadRef;
  };

  const openLink = useEffectEvent(async (url: string) => {
    const isFile = url.startsWith("file:");
    const routeParams = router.state.matches.at(-1)?.params ?? {};
    const threadRef =
      threadShowingBrowser(
        routeParams,
        isFile ? (primaryEnvironment?.environmentId ?? null) : null,
      ) ?? (await startThread(url));
    if (threadRef === null) return;
    // An HTML file is served from the environment, which runs on this machine.
    const result = isFile
      ? httpBaseUrl === null
        ? null
        : await openFileInPreview({
            threadRef,
            filePath: decodeURIComponent(new URL(url).pathname),
            workspaceRoot: undefined,
            httpBaseUrl,
            createAssetUrl,
            openPreview,
          })
      : await openUrlInPreview({ threadRef, url, openPreview });
    if (result === null) {
      reportFailure(url);
      return;
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      reportFailure(url, error instanceof Error ? error.message : url);
    }
  });

  useEffect(() => {
    if (!ready || webLinks === undefined) return;
    let subscribed = true;
    // Links open one at a time, in the order they came.
    const unsubscribe = webLinks.onOpen((url) => {
      queueRef.current = queueRef.current.then(() => openLink(url)).catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive links.
    queueMicrotask(() => {
      if (subscribed) void webLinks.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void webLinks.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [ready, webLinks]);

  return null;
}
