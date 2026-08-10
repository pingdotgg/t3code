import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../components/settings/SkillsSettings";

export const Route = createFileRoute("/settings/skills")({
  component: SkillsSettings,
});
