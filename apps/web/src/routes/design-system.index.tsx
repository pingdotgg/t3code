import { createFileRoute } from "@tanstack/react-router";

import { DesignSystemPage } from "../components/design-system/DesignSystemPage";

/** A live catalog of the design system. Dev only, through the parent route. */
export const Route = createFileRoute("/design-system/")({
  component: DesignSystemPage,
});
