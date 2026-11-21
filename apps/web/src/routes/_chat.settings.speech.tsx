import { createFileRoute } from "@tanstack/react-router";
import { SpeechSettingsPanel } from "../components/settings/SpeechSettingsPanel";

export const Route = createFileRoute("/_chat/settings/speech")({ component: SpeechSettingsPanel });
