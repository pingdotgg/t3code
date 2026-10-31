import { createFileRoute } from "@tanstack/react-router";

import { LinearPage } from "../components/linear/LinearPage";
import { parseLinearSearch, type LinearSearch } from "../components/linear/linearSearch";

export const Route = createFileRoute("/_chat/linear")({
  validateSearch: (raw: Record<string, unknown>): LinearSearch => parseLinearSearch(raw),
  component: LinearPage,
});
