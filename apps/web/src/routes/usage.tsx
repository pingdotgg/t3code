import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import { useEscapeToGoBack } from "../hooks/useEscapeToGoBack";

function UsageRouteView() {
  useEscapeToGoBack();
  return <UsagePage />;
}

export const Route = createFileRoute("/usage")({
  component: UsageRouteView,
});
