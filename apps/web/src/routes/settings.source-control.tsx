import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";
import { usePrimarySettingsWritable } from "../state/environments";

/**
 * Every control on this page writes to the primary environment's
 * `settings.json`. Where no primary environment exists (the hosted static web
 * app, or a CLI-served app whose server went away) those writes are discarded,
 * so the page is dropped instead of rendering an inert copy of itself. The
 * sidebar hides the entry too; this guard covers deep links and history.
 */
function SettingsSourceControlRoute() {
  const navigate = useNavigate();
  const primarySettingsWritable = usePrimarySettingsWritable();

  useEffect(() => {
    if (primarySettingsWritable) {
      return;
    }
    void navigate({ to: "/settings/general", replace: true });
  }, [navigate, primarySettingsWritable]);

  if (!primarySettingsWritable) {
    return null;
  }

  return <SourceControlSettingsPanel />;
}

export const Route = createFileRoute("/settings/source-control")({
  component: SettingsSourceControlRoute,
});
