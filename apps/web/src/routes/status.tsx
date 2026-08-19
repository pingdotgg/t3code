import { createFileRoute } from "@tanstack/react-router";

import { StatusPage } from "../components/status/StatusPage";

export const Route = createFileRoute("/status")({
  component: StatusPage,
});
