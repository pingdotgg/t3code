import { createFileRoute, notFound } from "@tanstack/react-router";

import { DesignSystemPage } from "../components/design-system/DesignSystemPage";

/** A live catalog of the design system. Dev builds only; production builds 404. */
export const Route = createFileRoute("/design-system")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: DesignSystemPage,
});
