import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEditorOpening } from "../../editorPreferences";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { toastManager } from "../ui/toast";

/**
 * Opens the workspace through the selected editor route on its keybinding.
 * Events already handled by another picker are ignored to avoid duplicate launches.
 */
export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const { preferredEditor, openEditor } = useEditorOpening(environmentId, availableEditors);

  useEffect(() => {
    if (!enabled) return;
    /** Consumes an unhandled matching shortcut and displays any editor-launch failure. */
    function handler(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      void openEditor(openInCwd).then((result) => {
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Unable to open editor",
            description: error instanceof Error ? error.message : "Unknown error opening editor.",
          });
        }
      });
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings, openInCwd, openEditor, preferredEditor]);
}
