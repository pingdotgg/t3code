import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/home/HomePage";

export const Route = createFileRoute("/_chat/home")({
  component: HomePage,
});
