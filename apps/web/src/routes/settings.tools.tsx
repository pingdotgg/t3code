import { createFileRoute, useLocation } from "@tanstack/react-router";

import { ToolsSettings } from "../components/settings/ToolsSettings";
import { validateToolsSearch } from "../components/settings/toolsSettings.logic";

function SettingsToolsRoute() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  // A settings search result links by hash, so it opens the tab it points at.
  const hash = useLocation({ select: (location) => location.hash });
  const resolvedTab = tab ?? (hash === "tools-mcp-servers" ? "mcp" : undefined);
  return (
    <ToolsSettings
      {...(resolvedTab === undefined ? {} : { tab: resolvedTab })}
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

export const Route = createFileRoute("/settings/tools")({
  validateSearch: validateToolsSearch,
  component: SettingsToolsRoute,
});
