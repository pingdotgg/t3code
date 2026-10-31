import { createFileRoute } from "@tanstack/react-router";

import { LinearPage } from "../components/linear/LinearPage";
import { validateLinearRouteSearch } from "@t3tools/client-runtime/linear/search";

export const Route = createFileRoute("/_chat/linear")({
  validateSearch: validateLinearRouteSearch,
  component: LinearPage,
});
