import { createFileRoute } from "@tanstack/react-router";

import { HermesSkillsSettings } from "../components/settings/HermesSkillsSettings";
import { T3_WORK_SETTINGS_SCROLL_CLASS_NAME } from "./settings.hermes-cron";

export const Route = createFileRoute("/settings/hermes-skills")({
  component: HermesSkillsSettingsPage,
});

function HermesSkillsSettingsPage() {
  return (
    <div className={T3_WORK_SETTINGS_SCROLL_CLASS_NAME}>
      <HermesSkillsSettings />
    </div>
  );
}
