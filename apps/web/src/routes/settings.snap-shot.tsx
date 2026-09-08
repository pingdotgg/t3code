import { createFileRoute } from "@tanstack/react-router";

import { SnapShotSettings } from "../components/settings/SnapShotSettings";

function SettingsSnapShotRoute() {
  return <SnapShotSettings />;
}

export const Route = createFileRoute("/settings/snap-shot")({
  component: SettingsSnapShotRoute,
});
