import { msg } from "gt-react";

export const FORK_ROLES_SETTINGS_SEARCH_ITEMS = [
  {
    id: "fork-roles-directory",
    title: msg("Roles directory"),
    to: "/settings/scheduled-tasks",
    scope: "environment-defaults",
    searchTerms: [msg("roles role briefs folder path standing job agent")],
  },
] as const;
