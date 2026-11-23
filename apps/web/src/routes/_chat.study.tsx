import { createFileRoute } from "@tanstack/react-router";

import { StudyPage } from "../kompas/StudyPage";

function StudyRoute() {
  return <StudyPage session={Route.useSearch().session} />;
}

export const Route = createFileRoute("/_chat/study")({
  validateSearch: (raw: Record<string, unknown>): { session?: string } =>
    typeof raw.session === "string" && raw.session ? { session: raw.session.slice(0, 100) } : {},
  component: StudyRoute,
});
