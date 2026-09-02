import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

import { surfaceTitle } from "../components/RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";
import { buildShellRightPanelState } from "./shellRightPanelState";

export interface ShellRightPanelBridgeProps {
  readonly threadRef: ScopedThreadRef;
  readonly isOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly canAdd: {
    readonly diff: boolean;
    readonly files: boolean;
    readonly terminal: boolean;
    readonly pullRequest: boolean;
    readonly agents: boolean;
  };
  readonly onToggle: () => void;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onClose: (surface: RightPanelSurface) => void;
  readonly onAddDiff: () => void;
  readonly onAddFiles: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddAgents: () => void;
}

/**
 * Mounted by ChatView when the Qt shell hosts the app. Publishes the right
 * panel's tab model and routes tab actions to ChatView's handlers; the
 * content itself is rendered by the embed route in the shell's second web
 * view, which converges on the same tab model through localStorage.
 */
export function ShellRightPanelBridge(props: ShellRightPanelBridgeProps) {
  const state = useMemo(
    () =>
      buildShellRightPanelState({
        threadKey: scopedThreadKey(props.threadRef),
        environmentId: props.threadRef.environmentId,
        threadId: props.threadRef.threadId,
        isOpen: props.isOpen,
        activeSurfaceId: props.activeSurfaceId,
        surfaces: props.surfaces,
        titleFor: (surface) =>
          surfaceTitle(surface, props.previewSessions, props.terminalLabelsById),
        canAdd: props.canAdd,
      }),
    [props],
  );

  useShellPublish("rightPanel", state);

  useShellActions((action) => {
    switch (action.type) {
      case "rightPanel.toggle":
        props.onToggle();
        return;
      case "rightPanel.activate": {
        const surface = props.surfaces.find((item) => item.id === action.id);
        if (surface) props.onActivate(surface);
        return;
      }
      case "rightPanel.close": {
        const surface = props.surfaces.find((item) => item.id === action.id);
        if (surface) props.onClose(surface);
        return;
      }
      case "rightPanel.add":
        switch (action.kind) {
          case "diff":
            props.onAddDiff();
            return;
          case "files":
            props.onAddFiles();
            return;
          case "terminal":
            props.onAddTerminal();
            return;
          case "pull-request":
            props.onAddPullRequest();
            return;
          case "agents":
            props.onAddAgents();
            return;
        }
        return;
      default:
        return;
    }
  });

  return null;
}
