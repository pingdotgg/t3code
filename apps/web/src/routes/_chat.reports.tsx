import { createFileRoute, redirect } from "@tanstack/react-router";

// Reports are read in the inbox now. Old links and bookmarks land there.
export const Route = createFileRoute("/_chat/reports")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});
