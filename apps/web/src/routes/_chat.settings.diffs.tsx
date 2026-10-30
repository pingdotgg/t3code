import { createFileRoute } from "@tanstack/react-router";
import { DiffsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/diffs")({ component: DiffsSettingsPanel });
