import { createFileRoute } from "@tanstack/react-router";

import { issuesSearchFromUrl } from "../components/issue/issuesSearch.logic";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: issuesSearchFromUrl,
});
