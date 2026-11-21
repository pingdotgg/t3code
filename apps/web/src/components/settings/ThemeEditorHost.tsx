import { msg } from "gt-react";
import { lazy, Suspense, useSyncExternalStore } from "react";

import { useTheme } from "../../hooks/useTheme";
import { m } from "../../i18n/messages";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useThemeEditorStore } from "./themeEditorStore";
import { definePluginComponent } from "~/plugins/features";

export const ThemeEditorHost = definePluginComponent(
  "component:components/settings/ThemeEditorHost/ThemeEditorHost",
  PluginOriginalThemeEditorHost,
);

const PluginOriginalThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);
const ThemeEditorPanel = definePluginComponent(
  "component:components/settings/ThemeEditorHost/ThemeEditorPanel",
  PluginOriginalThemeEditorPanel,
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

function PluginOriginalThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);

  const handleSaved = (
    savedTheme: ThemeDefinition,
    { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
  ) => {
    if (mergedAppearance) {
      if (!setTheme(savedTheme.id)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not save your theme")),
            description: m(msg("Browser storage is unavailable, so the change was not kept.")),
          }),
        );
        return false;
      }
      return true;
    }
    if (!created) {
      // Reapply the palette without setTheme, which would clear a mix containing the edited theme.
      const wasActive =
        getThemeDefinition(theme)?.id === savedTheme.id ||
        themeHalves?.light === savedTheme.id ||
        themeHalves?.dark === savedTheme.id;
      if (wasActive) refreshTheme();
      return true;
    }

    if (!setTheme(savedTheme.id)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not save your theme")),
          description: m(msg("Browser storage is unavailable, so the change was not kept.")),
        }),
      );
      return false;
    }
    return true;
  };

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
