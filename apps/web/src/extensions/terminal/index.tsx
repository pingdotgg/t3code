import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer, SurfaceRendererProps } from "@t3tools/extension-sdk/react";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalDrawerProps,
  type PersistentThreadTerminalPanelProps,
} from "./PersistentThreadTerminal";

export type TerminalBindings =
  | { placement: "bottom-dock"; props: PersistentThreadTerminalDrawerProps }
  | { placement: "side-panel"; props: PersistentThreadTerminalPanelProps };

/** Bundled native bridge; PTY ownership and authenticated operations remain in the host engine. */
export function createTerminalExtension(
  useBindings: () => TerminalBindings,
): Extension<SurfaceRenderer> {
  function TerminalSurface({ snapshot }: SurfaceRendererProps) {
    const bindings = useBindings();
    const visible = snapshot.status === "ready";
    if (bindings.placement === "bottom-dock") {
      return <PersistentThreadTerminalDrawer {...bindings.props} presentationVisible={visible} />;
    }
    return (
      <PersistentThreadTerminalPanel
        {...bindings.props}
        visible={visible && bindings.props.visible}
      />
    );
  }

  return {
    manifest: {
      id: "t3.terminal",
      apiVersion: 1,
      version: "0.1.0",
      surfaces: [
        {
          id: "t3.terminal/view",
          title: "Terminal",
          placements: ["side-panel", "bottom-dock"],
          clients: ["web", "desktop"],
          scope: "thread",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "t3.terminal/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: TerminalSurface }),
      },
    ],
  };
}
