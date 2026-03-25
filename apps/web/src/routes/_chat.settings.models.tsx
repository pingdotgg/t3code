import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/models")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});
