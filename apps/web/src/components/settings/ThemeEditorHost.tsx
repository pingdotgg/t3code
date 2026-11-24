import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { msg } from "gt-react";
import { lazy, Suspense, useSyncExternalStore } from "react";

import { useTheme } from "../../hooks/useTheme";
import { m } from "../../i18n/messages";
import { serverEnvironment, themeServerEditableEnvironmentIdAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  environmentThemeFile,
  getThemeDefinition,
  isPublishedTheme,
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
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  const { theme, setTheme, themeHalves, refreshTheme } = useTheme();
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);
  const editableEnvironmentId = useAtomValue(themeServerEditableEnvironmentIdAtom);
  const saveEnvironmentTheme = useAtomCommand(serverEnvironment.saveEnvironmentTheme, {
    reportFailure: false,
  });
  const savesToEnvironment =
    editingTheme !== null && editableEnvironmentId !== null && isPublishedTheme(editingTheme.id);

  const handleSaveToEnvironment = async (edited: ThemeDefinition) => {
    if (editableEnvironmentId === null) return false;
    const result = await saveEnvironmentTheme({
      environmentId: editableEnvironmentId,
      input: { themeId: edited.id, theme: environmentThemeFile(edited) },
    });
    if (result._tag === "Success") return true;
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    // The server's refusal says what to change, such as CSS that loads files.
    if (error?._tag === "EnvironmentThemeError") throw new Error(error.message);
    return false;
  };

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
        onSaveToEnvironment={savesToEnvironment ? handleSaveToEnvironment : undefined}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
