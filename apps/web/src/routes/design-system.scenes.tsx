import { createFileRoute } from "@tanstack/react-router";

import { ScenesPage } from "../components/design-system/scenes/ScenesPage";

/** Drives the real timeline through scripted turns, for checking against the board. Dev only. */
export const Route = createFileRoute("/design-system/scenes")({
  validateSearch: (search: Record<string, unknown>): { script?: string } =>
    typeof search.script === "string" ? { script: search.script } : {},
  component: ScenesRouteView,
});

function ScenesRouteView() {
  const { script } = Route.useSearch();
  return <ScenesPage scriptId={script} />;
}
