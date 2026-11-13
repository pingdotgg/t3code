import { createFileRoute } from "@tanstack/react-router";
import { TipsSettingsPanel } from "../components/settings/TipsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/tips")({ component: TipsSettingsPanel });
