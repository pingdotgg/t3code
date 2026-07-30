import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/appearance")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/interface", replace: true });
  },
});
