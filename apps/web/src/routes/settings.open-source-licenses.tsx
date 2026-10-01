import { createFileRoute } from "@tanstack/react-router";

import { OpenSourceLicensesPanel } from "../components/settings/OpenSourceLicenses";

export const Route = createFileRoute("/settings/open-source-licenses")({
  component: OpenSourceLicensesPanel,
});
