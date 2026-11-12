import { createFileRoute } from "@tanstack/react-router";
import { AboutSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/about")({ component: AboutSettingsPanel });
