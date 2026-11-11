import { createFileRoute } from "@tanstack/react-router";

// Renamed to /settings/browser; the settings route redirects old links.
export const Route = createFileRoute("/_chat/settings/integrations")({});
