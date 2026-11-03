import { createFileRoute, useLocation } from "@tanstack/react-router";

import { ToolsSettings } from "../components/settings/ToolsSettings";
import { validateToolsSearch } from "../components/settings/toolsSettings.logic";

function SettingsToolsRoute() {
  const { tab, skill, server } = Route.useSearch();
  const navigate = Route.useNavigate();
  // A settings search result links by hash, so it opens the tab it points at.
  const hash = useLocation({ select: (location) => location.hash });
  const resolvedTab = tab ?? (hash === "tools-mcp-servers" ? "mcp" : undefined);
  return (
    <ToolsSettings
      {...(resolvedTab === undefined ? {} : { tab: resolvedTab })}
      {...(skill === undefined ? {} : { skill })}
      {...(server === undefined ? {} : { server })}
      onTabChange={(next) =>
        void navigate({
          // The settings route keeps the scope; Skills is the default tab.
          search: next === "skills" ? {} : { tab: next },
          replace: true,
          resetScroll: false,
        })
      }
      // Like a tab, a skill's or server's page replaces the entry: Escape from
      // the list then still leaves Settings rather than reopening the page.
      onOpenSkill={(name) =>
        void navigate({
          search: name === null ? {} : { skill: name },
          replace: true,
          resetScroll: false,
        })
      }
      onOpenServer={(name) =>
        void navigate({
          search: name === null ? { tab: "mcp" } : { tab: "mcp", server: name },
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
