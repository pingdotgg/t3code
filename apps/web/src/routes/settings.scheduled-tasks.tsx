import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/scheduled-tasks")({
  beforeLoad: async () => {
    throw redirect({ to: "/scheduled-tasks", replace: true });
  },
});
