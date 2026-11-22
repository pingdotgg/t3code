import { createFileRoute } from "@tanstack/react-router";
import { ElectronicsSettings } from "../components/electronics/ElectronicsSettings";

export const Route = createFileRoute("/_chat/settings/electronics")({
  component: ElectronicsSettings,
});
