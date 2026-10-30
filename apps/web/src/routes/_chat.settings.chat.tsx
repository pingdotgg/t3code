import { createFileRoute } from "@tanstack/react-router";
import { ChatSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/chat")({ component: ChatSettingsPanel });
