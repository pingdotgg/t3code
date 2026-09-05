import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectsPage } from "../components/projects/ProjectsPage";

export const Route = createFileRoute("/projects/")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectsPage,
});
