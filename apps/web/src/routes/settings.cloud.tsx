import { createFileRoute, redirect } from "@tanstack/react-router";

import { CloudSettingsPanel } from "../components/settings/CloudSettings";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

export const Route = createFileRoute("/settings/cloud")({
  beforeLoad: () => {
    if (!hasCloudPublicConfig()) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: CloudSettingsPanel,
});
