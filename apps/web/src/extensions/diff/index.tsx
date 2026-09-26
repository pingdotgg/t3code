import { lazy, Suspense, type ComponentProps } from "react";
import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";

const DiffPanel = lazy(() => import("../../components/DiffPanel"));

export type DiffBindings = Omit<ComponentProps<typeof DiffPanel>, "mode"> & {
  readonly panelKey: string;
};

export function createDiffExtension(useBindings: () => DiffBindings): Extension<SurfaceRenderer> {
  const Renderer: SurfaceRenderer = function DiffExtensionRenderer() {
    const { panelKey, composerDraftTarget, workspaceMutationId } = useBindings();
    return (
      <Suspense fallback={null}>
        <DiffPanel
          key={panelKey}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    );
  };

  return {
    manifest: {
      id: "t3.diff",
      apiVersion: 1,
      version: "0.1.0",
      surfaces: [
        {
          id: "t3.diff/view",
          title: "Diff",
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
        id: "t3.diff/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: Renderer }),
      },
    ],
  };
}
