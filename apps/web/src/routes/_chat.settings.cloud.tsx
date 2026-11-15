import { createFileRoute } from "@tanstack/react-router";
import { BoatCloudSettingsPanel } from "../components/settings/BoatCloudSettings";

export const Route = createFileRoute("/_chat/settings/cloud")({
  component: BoatCloudSettingsPanel,
});
