import { createFileRoute } from "@tanstack/react-router";

import { VideoThemeSettingsPanel } from "../components/settings/VideoThemeSettingsPanel";

export const Route = createFileRoute("/_chat/settings/video-theme")({
  component: VideoThemeSettingsPanel,
});
