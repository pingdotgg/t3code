import { buildRemoteOpenUrl, type EditorId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import { announce } from "../../lib/announce";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "../../remoteOpen";
import { registerCommands } from "../../shortcuts/dispatcher";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

/** Marks an OpenInPicker's primary button as the target of `editor.openFavorite`. */
export const OPEN_FAVORITE_EDITOR_ATTRIBUTE = "data-open-favorite-editor";

/**
 * Fallback used when the marked primary button is missing or disabled. Published by
 * `useOpenFavoriteEditorShortcut` so the capture-phase command can try the button first
 * without a newer registry entry outranking it.
 */
let openFavoriteEditorFallback: (() => boolean) | null = null;

/**
 * `editor.openFavorite` presses the marked OpenInPicker primary button, so the shortcut opens
 * exactly what the button on screen would. A missing or disabled button runs the published
 * fallback (cwd + preferred editor). Capture phase, so a focused terminal does not swallow the chord.
 */
export function registerOpenFavoriteEditorCommand(): () => void {
  return registerCommands(
    {
      "editor.openFavorite": (event) => {
        if (event.repeat) return false;
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(`[${OPEN_FAVORITE_EDITOR_ATTRIBUTE}]`),
        ].at(-1);
        if (button !== undefined && !button.disabled) {
          event.preventDefault();
          button.click();
          return;
        }
        if (openFavoriteEditorFallback?.() !== true) return false;
        event.preventDefault();
      },
    },
    { capture: true },
  );
}

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  // Matches the picker: remote editors run on the viewing machine.
  const [preferredEditor] = usePreferredEditor(
    remote.mode === "local-exec" ? availableEditors : remoteCapableEditors,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the open-favorite fallback into the shared command while enabled
  useEffect(() => {
    if (!enabled || remote.mode === "remote-unavailable") {
      openFavoriteEditorFallback = null;
      return;
    }
    openFavoriteEditorFallback = () => {
      if (!openInCwd || !preferredEditor) return false;
      const label = editorLabelForPlatform(preferredEditor, navigator.platform);
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor: preferredEditor,
          ...remote.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) return false;
        void openRemoteEditorUrl(url).then((opened) => {
          if (opened) announce(`Opened in ${label}`);
        });
        return true;
      }
      void openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: preferredEditor,
        },
      }).then((result) => {
        if (result._tag === "Success") announce(`Opened in ${label}`);
      });
      return true;
    };
    return () => {
      openFavoriteEditorFallback = null;
    };
  }, [enabled, environmentId, openInCwd, openInEditorMutation, preferredEditor, remote]);
}
