import { createFileRoute } from "@tanstack/react-router";

import { GuestPage } from "../components/guest/GuestPage";

export const Route = createFileRoute("/guest")({
  component: GuestPage,
});
