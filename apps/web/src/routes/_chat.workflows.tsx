import { createFileRoute } from "@tanstack/react-router";

import { workflowsSearchFromUrl } from "../components/workflows/workflowsSearch.logic";

export const Route = createFileRoute("/_chat/workflows")({
  validateSearch: workflowsSearchFromUrl,
});
