import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer, SurfaceRendererProps } from "@t3tools/extension-sdk/react";
import { lazy, Suspense, type ComponentProps } from "react";
import type { PreviewPanel as NativePreviewPanel } from "../../components/preview/PreviewPanel";

const PreviewPanel = lazy(() =>
  import("../../components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);

/** Trusted native props; browser sessions, credentials and annotation submission stay host-owned. */
export type BrowserBindings = Omit<ComponentProps<typeof NativePreviewPanel>, "mode">;

export function createBrowserExtension(
  useBindings: () => BrowserBindings,
): Extension<SurfaceRenderer> {
  function BrowserSurface({ snapshot }: SurfaceRendererProps) {
    const bindings = useBindings();
    return (
      <Suspense fallback={null}>
        <PreviewPanel
          {...bindings}
          mode="embedded"
          visible={bindings.visible && snapshot.status === "ready"}
        />
      </Suspense>
    );
  }

  return {
    manifest: {
      id: "t3.browser",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: "t3.browser/view",
          title: "Browser",
          scope: "thread",
          placements: ["side-panel"],
          clients: ["web", "desktop"],
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "t3.browser/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: BrowserSurface }),
      },
    ],
  };
}
