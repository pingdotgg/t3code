import { useCallback } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n";
import { getThemeDefinition, type ThemeAppearance, type ThemeDefinition } from "../../themePalette";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { useThemeEditorStore } from "./themeEditorStore";

/**
 * Renders the theme editor above the router. The editor paints its draft on
 * the live app, so it has to outlive the settings route: the point is to walk
 * through threads, panels, and pages while the colors are being tuned.
 */
export function ThemeEditorHost() {
  const { t } = useI18n();
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();

  // The panel reports which path it actually took: a theme removed while its
  // editor is open resolves to null there, so the save becomes a create even
  // though the session still names it.
  const handleSaved = useCallback(
    (
      savedTheme: ThemeDefinition,
      { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
    ) => {
      // A merge completed an existing theme's light/dark pair; activating the
      // whole theme shows the new palette right away.
      if (mergedAppearance) {
        if (!setTheme(savedTheme.id)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("theme.saveFailed"),
              description: t("theme.storageUnavailable"),
            }),
          );
          return false;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: t("theme.updatedNamed", { name: savedTheme.label }),
            description: t("theme.paletteAdded", {
              appearance: t(`theme.appearance.${mergedAppearance}`),
            }),
          }),
        );
        return true;
      }
      if (!created) {
        // The edited theme may be showing through the base preference or either
        // half of the mix; the preference itself is untouched (a setTheme here
        // would clear the mix), the palette just needs re-applying.
        const wasActive =
          getThemeDefinition(theme)?.id === savedTheme.id ||
          themeHalves?.light === savedTheme.id ||
          themeHalves?.dark === savedTheme.id;
        if (wasActive) refreshTheme();
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: t("theme.savedNamed", { name: savedTheme.label }),
            description: t(wasActive ? "theme.changesActive" : "theme.changesSaved"),
          }),
        );
        return true;
      }

      if (!setTheme(savedTheme.id)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("theme.saveFailed"),
            description: t("theme.storageUnavailable"),
          }),
        );
        return false;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("theme.createdNamed", { name: savedTheme.label }),
          description: t("theme.nowActive"),
        }),
      );
      return true;
    },
    [refreshTheme, setTheme, t, theme, themeHalves],
  );

  if (!session) return null;

  // Resolve on every render: an edit or import can change the stored
  // definitions while a session is open.
  const editingTheme = session.editingThemeId
    ? (getThemeDefinition(session.editingThemeId) ?? null)
    : null;
  const seedTheme = session.seedThemeId ? (getThemeDefinition(session.seedThemeId) ?? null) : null;

  return (
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
  );
}
