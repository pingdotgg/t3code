import { createFileRoute } from "@tanstack/react-router";
import { GameDevelopmentSettingsPanel } from "../components/settings/GameDevelopmentSettingsPanel";

export const Route = createFileRoute("/_chat/settings/game-development")({
  component: GameDevelopmentSettingsPanel,
});
