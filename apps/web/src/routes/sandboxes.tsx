import { createFileRoute } from "@tanstack/react-router";

import { SandboxesPage, type SandboxesSearch } from "../sandboxes/SandboxesPage";

export const Route = createFileRoute("/sandboxes")({
  validateSearch: (raw: Record<string, unknown>): SandboxesSearch =>
    typeof raw.host === "string" && raw.host.length > 0 ? { host: raw.host } : {},
  component: SandboxesPage,
});
