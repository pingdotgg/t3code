import { createFileRoute } from "@tanstack/react-router";

import { ToolsSettings } from "../components/settings/ToolsSettings";
import { validateToolsSearch } from "../components/settings/toolsSettings.logic";

function SettingsToolsRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ToolsSettings
      {...(tab === undefined ? {} : { tab })}
      onTabChange={(next) =>
        void navigate({
          // The settings route keeps the scope; Skills is the default tab.
          search: next === "skills" ? {} : { tab: next },
          replace: true,
          resetScroll: false,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/tools")({
  validateSearch: validateToolsSearch,
  component: SettingsToolsRoute,
});
