import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// The viewer and its parsers load only when this page opens.
const ModelViewerPage = lazy(() => import("../components/files/ModelViewerPage"));

export const Route = createFileRoute("/model-viewer")({
  component: ModelViewerRouteView,
});

function ModelViewerRouteView() {
  return (
    <Suspense fallback={null}>
      <ModelViewerPage />
    </Suspense>
  );
}
