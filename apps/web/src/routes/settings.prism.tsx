import { createFileRoute } from "@tanstack/react-router";
import { PrismSettings } from "../components/settings/PrismSettings";

export const Route = createFileRoute("/settings/prism")({ component: PrismSettings });
