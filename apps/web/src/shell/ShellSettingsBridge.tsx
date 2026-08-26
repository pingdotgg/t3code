import { ShellAction } from "@t3tools/contracts";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { scrollToSettingsTarget } from "../components/settings/settingsLayout";
import { buildShellSettingsState, isSettingsPath } from "./shellSettingsState";

const isShellAction = Schema.is(ShellAction);

/**
 * Mounted from the root route when the Qt shell hosts the app. Publishes the
 * settings navigation (sections, active one, search results) and turns
 * settings.* actions into the same navigation SettingsSidebarNav performs.
 * The settings pages themselves stay HTML in the primary web view.
 */
export function ShellSettingsBridge() {
  const shell = window.t3Shell;
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const [searchQuery, setSearchQuery] = useState("");

  const state = useMemo(
    () => buildShellSettingsState({ pathname, searchQuery }),
    [pathname, searchQuery],
  );
  useEffect(() => {
    if (!shell) return;
    void shell.publish("settings", state);
  }, [shell, state]);

  const latest = useRef({ navigate, canGoBack, pathname, hash });
  latest.current = { navigate, canGoBack, pathname, hash };
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        const current = latest.current;
        switch (candidate.type) {
          case "settings.navigate":
            if (!isSettingsPath(candidate.to)) return;
            setSearchQuery("");
            void current.navigate({
              to: candidate.to,
              hash: "",
              replace: true,
              hashScrollIntoView: false,
            });
            return;
          case "settings.openResult": {
            if (!isSettingsPath(candidate.to)) return;
            setSearchQuery("");
            const targetId = candidate.targetId ?? "";
            if (
              targetId.length > 0 &&
              current.pathname === candidate.to &&
              current.hash.replace(/^#/, "") === targetId
            ) {
              scrollToSettingsTarget(targetId);
              return;
            }
            void current.navigate({
              to: candidate.to,
              hash: targetId,
              replace: true,
              hashScrollIntoView: false,
            });
            return;
          }
          case "settings.search":
            setSearchQuery(candidate.query);
            return;
          case "settings.back":
            if (current.canGoBack) {
              window.history.back();
              return;
            }
            void current.navigate({ to: "/" });
            return;
          default:
            return;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [shell]);

  return null;
}
