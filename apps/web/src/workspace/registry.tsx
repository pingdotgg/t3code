import { lazy, Suspense, useCallback, type ReactNode } from "react";

import ChatView from "../components/ChatView";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useWorkspaceActions } from "../components/workspace/WorkspaceProvider";
import type { MainSurface, SecondarySurface } from "./types";

const LazyDiffPanel = lazy(() => import("../components/DiffPanel"));

export type WorkspaceSecondaryRenderMode = "sidebar" | "sheet";

function DiffFallback(props: { mode: DiffPanelMode }) {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
}

function RegisteredDiffSurface(props: {
  surface: Extract<SecondarySurface, { id: "diff" }>;
  renderMode: WorkspaceSecondaryRenderMode;
}) {
  const { updateSurface } = useWorkspaceActions();
  const diffMode: DiffPanelMode = props.renderMode === "sheet" ? "sheet" : "sidebar";
  const onFocusChange = useCallback(
    (focus: Extract<SecondarySurface, { id: "diff" }>["input"]["focus"]) => {
      updateSurface(
        "secondary",
        {
          threadRef: props.surface.input.threadRef,
          focus,
        },
        { replace: false },
      );
    },
    [props.surface.input.threadRef, updateSurface],
  );

  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffFallback mode={diffMode} />}>
        <LazyDiffPanel
          threadRef={props.surface.input.threadRef}
          focus={props.surface.input.focus}
          mode={diffMode}
          onFocusChange={onFocusChange}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}

export function renderMainSurface(surface: MainSurface): ReactNode {
  switch (surface.id) {
    case "chat":
      return surface.input.kind === "server" ? (
        <ChatView
          environmentId={surface.input.threadRef.environmentId}
          threadId={surface.input.threadRef.threadId}
          routeKind="server"
        />
      ) : (
        <ChatView
          draftId={surface.input.draftId}
          environmentId={surface.input.environmentId}
          threadId={surface.input.threadId}
          routeKind="draft"
        />
      );
  }
}

export function renderSecondarySurface(
  surface: SecondarySurface,
  renderMode: WorkspaceSecondaryRenderMode,
): ReactNode {
  switch (surface.id) {
    case "diff":
      return <RegisteredDiffSurface surface={surface} renderMode={renderMode} />;
  }
}
