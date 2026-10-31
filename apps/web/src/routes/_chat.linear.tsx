import { createFileRoute } from "@tanstack/react-router";

import { LinearPage } from "../components/linear/LinearPage";
import { validateLinearRouteSearch } from "../components/linear/linearSearch";

export const Route = createFileRoute("/_chat/linear")({
  validateSearch: validateLinearRouteSearch,
  component: LinearPage,
});
