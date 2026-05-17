import { createFileRoute, redirect } from "@tanstack/react-router";

// ACP Registry was merged into the Providers page so installing an agent
// auto-registers it as a provider instance. Keep the URL working for any
// bookmarks or external links by redirecting here.
export const Route = createFileRoute("/settings/acp-registry")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/providers", replace: true });
  },
});
