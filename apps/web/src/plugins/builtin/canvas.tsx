import { msg } from "gt-react";
import { PenTool } from "lucide-react";
import { lazy } from "react";

import { retainCanvasEnvironment } from "~/components/canvas/canvasDocumentStore";
import { m } from "~/i18n/messages";
import type { ClientPluginSdk } from "../PluginHost";
import { PluginSlot } from "../features";
import type { PluginPanelProps } from "../panels";

/** Canvas owns its launcher, renderers and agent host for one environment generation. */
export function activate(sdk: ClientPluginSdk) {
  const CanvasPanel = lazy(() =>
    import("~/components/canvas/CanvasPanel").then((module) => ({ default: module.CanvasPanel })),
  );
  const CanvasFloatingView = lazy(() =>
    import("~/components/canvas/CanvasFloatingView").then((module) => ({
      default: module.CanvasFloatingView,
    })),
  );
  const CanvasHosts = lazy(() =>
    import("~/components/canvas/CanvasHosts").then((module) => ({ default: module.CanvasHosts })),
  );
  const CanvasMiniPlayer = lazy(() =>
    import("~/components/preview/ThreadPreviewMiniPlayer").then((module) => ({
      default: module.CanvasMiniPlayer,
    })),
  );
  function CanvasPluginPanel(props: PluginPanelProps) {
    if (props.surface?.kind !== "canvas") return null;
    return (
      <PluginSlot
        slot="canvas.panel"
        props={{
          threadRef: props.threadRef,
          surface: props.surface,
          projectId: props.projectId ?? null,
          mode: props.mode ?? "embedded",
          visible: props.visible ?? true,
        }}
      />
    );
  }
  sdk.onDispose(retainCanvasEnvironment(sdk.environmentId));
  sdk.panels.register([
    {
      id: "canvas",
      title: m(msg("Canvas")),
      description: m(msg("Design with agents on a shared canvas.")),
      icon: PenTool,
      shortcut: "C",
      surfaceKind: "canvas",
      available: ({ projectId }) => projectId !== null,
      unavailableReason: m(msg("Canvases are only available when a project is open.")),
      component: CanvasPluginPanel,
    },
  ]);
  sdk.register([{ slot: "canvas.panel", component: CanvasPanel }]);
  sdk.register([{ slot: "canvas.floating", component: CanvasFloatingView }]);
  sdk.register([{ slot: "canvas.mini-player", component: CanvasMiniPlayer }]);
  sdk.register([{ slot: "canvas.host", component: CanvasHosts }]);
}
