import { createFileRoute } from "@tanstack/react-router";
import { LabsSettingsPanel } from "../components/settings/LabsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/labs")({ component: LabsSettingsPanel });
