import { createFileRoute } from "@tanstack/react-router";
import { BlenderSettingsPanel } from "../components/settings/BlenderSettings";

export const Route = createFileRoute("/_chat/settings/blender")({
  component: BlenderSettingsPanel,
});
