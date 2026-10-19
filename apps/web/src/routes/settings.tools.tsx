import { createFileRoute, redirect, retainSearchParams } from "@tanstack/react-router";

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
          search: (previous) => ({ ...previous, tab: next }),
          replace: true,
          resetScroll: false,
        })
      }
    />
  );
}

export const Route = createFileRoute("/settings/tools")({
  validateSearch: validateToolsSearch,
  search: { middlewares: [retainSearchParams(["tab"])] },
  beforeLoad: ({ location, search }) => {
    const tab =
      location.hash === "tools-mcp-servers"
        ? "mcp"
        : location.hash === "tools-skills"
          ? "skills"
          : location.hash === "web-provider" || location.hash === "web-provider-api-key"
            ? "web"
            : undefined;
    if (tab !== undefined && search.tab !== tab) {
      throw redirect({
        to: "/settings/tools",
        search: { ...search, tab },
        hash: location.hash,
        state: location.state,
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
      });
    }
  },
  component: SettingsToolsRoute,
});
