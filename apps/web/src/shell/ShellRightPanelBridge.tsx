import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type PreviewSessionSnapshot, ShellAction, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import { surfaceTitle } from "../components/RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";
import { buildShellRightPanelState } from "./shellRightPanelState";

const isShellAction = Schema.is(ShellAction);

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
  const shell = window.t3Shell;
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

  useEffect(() => {
    if (!shell) return;
    void shell.publish("rightPanel", state);
  }, [shell, state]);

  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        const current = latest.current;
        switch (candidate.type) {
          case "rightPanel.toggle":
            current.onToggle();
            return;
          case "rightPanel.activate": {
            const surface = current.surfaces.find((item) => item.id === candidate.id);
            if (surface) current.onActivate(surface);
            return;
          }
          case "rightPanel.close": {
            const surface = current.surfaces.find((item) => item.id === candidate.id);
            if (surface) current.onClose(surface);
            return;
          }
          case "rightPanel.add":
            switch (candidate.kind) {
              case "diff":
                current.onAddDiff();
                return;
              case "files":
                current.onAddFiles();
                return;
              case "terminal":
                current.onAddTerminal();
                return;
              case "pullRequest":
                current.onAddPullRequest();
                return;
              case "agents":
                current.onAddAgents();
                return;
            }
            return;
          default:
            return;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [shell]);

  return null;
}
