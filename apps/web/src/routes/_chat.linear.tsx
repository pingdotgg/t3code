import { createFileRoute } from "@tanstack/react-router";
import { LinearPage } from "../components/linear/LinearPage";
import { parseLinearSearch } from "../components/linear/linearSearch";
export const Route = createFileRoute("/_chat/linear")({
  validateSearch: parseLinearSearch,
  component: LinearPage,
});
