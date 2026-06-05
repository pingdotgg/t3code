import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/appearance")({
  beforeLoad: async () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
  component: () => null,
});
