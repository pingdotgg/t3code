import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { scrollToSettingsTarget } from "../components/settings/settingsLayout";
import { buildShellSettingsState, isSettingsPath } from "./shellSettingsState";
import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

/**
 * Mounted from the root route when the Qt shell hosts the app. Publishes the
 * settings navigation (sections, active one, search results) and turns
 * settings.* actions into the same navigation SettingsSidebarNav performs.
 * The settings pages themselves stay HTML in the primary web view.
 */
export function ShellSettingsBridge() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const [searchQuery, setSearchQuery] = useState("");

  const state = useMemo(
    () => buildShellSettingsState({ pathname, searchQuery }),
    [pathname, searchQuery],
  );
  useShellPublish("settings", state);

  useShellActions((action) => {
    switch (action.type) {
      case "settings.navigate":
        if (!isSettingsPath(action.to)) return;
        setSearchQuery("");
        void navigate({
          to: action.to,
          hash: "",
          replace: true,
          hashScrollIntoView: false,
        });
        return;
      case "settings.openResult": {
        if (!isSettingsPath(action.to)) return;
        setSearchQuery("");
        const targetId = action.targetId ?? "";
        if (targetId.length > 0 && pathname === action.to && hash.replace(/^#/, "") === targetId) {
          scrollToSettingsTarget(targetId);
          return;
        }
        void navigate({
          to: action.to,
          hash: targetId,
          replace: true,
          hashScrollIntoView: false,
        });
        return;
      }
      case "settings.search":
        setSearchQuery(action.query);
        return;
      case "settings.back":
        if (canGoBack) {
          window.history.back();
          return;
        }
        void navigate({ to: "/" });
        return;
      default:
        return;
    }
  });

  return null;
}
