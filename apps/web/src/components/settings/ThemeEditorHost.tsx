import { lazy, Suspense, useSyncExternalStore } from "react";

import { useT } from "../../hooks/useI18n";
import { useTheme } from "../../hooks/useTheme";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useThemeEditorStore } from "./themeEditorStore";

const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

export function ThemeEditorHost() {
  const t = useT();
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
            title: t("settings.system.themeHost.saveFailedTitle"),
            description: t("settings.system.themeHost.saveFailedBody"),
          }),
        );
        return false;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("settings.system.themeHost.updated", { label: savedTheme.label }),
          description: t("settings.system.themeHost.paletteAdded", {
            appearance:
              mergedAppearance === "dark"
                ? t("settings.system.themeHost.appearance.dark")
                : t("settings.system.themeHost.appearance.light"),
          }),
        }),
      );
      return true;
    }
    if (!created) {
      // Reapply the palette without setTheme, which would clear a mix containing the edited theme.
      const wasActive =
        getThemeDefinition(theme)?.id === savedTheme.id ||
        themeHalves?.light === savedTheme.id ||
        themeHalves?.dark === savedTheme.id;
      if (wasActive) refreshTheme();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("settings.system.themeHost.saved", { label: savedTheme.label }),
          description: wasActive
            ? t("settings.system.themeHost.nowActive")
            : t("settings.system.themeHost.changesSaved"),
        }),
      );
      return true;
    }

    if (!setTheme(savedTheme.id)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.themeHost.saveFailedTitle"),
          description: t("settings.system.themeHost.saveFailedBody"),
        }),
      );
      return false;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: t("settings.system.themeHost.created", { label: savedTheme.label }),
        description: t("settings.system.themeHost.itsActive"),
      }),
    );
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
