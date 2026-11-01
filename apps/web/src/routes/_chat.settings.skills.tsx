import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../components/settings/skills/SkillsSettings";

export const Route = createFileRoute("/_chat/settings/skills")({
  component: SkillsSettings,
});
