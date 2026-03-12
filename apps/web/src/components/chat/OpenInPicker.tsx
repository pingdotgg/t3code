import {
  EDITORS,
  type EditorId,
  type ResolvedKeybindingsConfig,
  type WorkspaceOpenTargetId,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { CursorIcon, GhosttyIcon, Icon, VisualStudioCode, Zed } from "../Icons";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

const LAST_EDITOR_KEY = "t3code:last-editor";

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  availableOpenTargets,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  availableOpenTargets: ReadonlyArray<WorkspaceOpenTargetId>;
  openInCwd: string | null;
}) {
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((editor) => editor.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });

  const allOptions = useMemo<Array<{ label: string; Icon: Icon; value: WorkspaceOpenTargetId }>>(
    () => [
      {
        label: "Cursor",
        Icon: CursorIcon,
        value: "cursor",
      },
      {
        label: "VS Code",
        Icon: VisualStudioCode,
        value: "vscode",
      },
      {
        label: "Zed",
        Icon: Zed,
        value: "zed",
      },
      {
        label: "Ghostty",
        Icon: GhosttyIcon,
        value: "ghostty",
      },
      {
        label: isMacPlatform(navigator.platform)
          ? "Finder"
          : isWindowsPlatform(navigator.platform)
            ? "Explorer"
            : "Files",
        Icon: FolderClosedIcon,
        value: "file-manager",
      },
    ],
    [],
  );
  const openTargetOptions = useMemo(
    () => allOptions.filter((option) => availableOpenTargets.includes(option.value)),
    [allOptions, availableOpenTargets],
  );
  const editorOptions = useMemo(
    () =>
      allOptions.filter(
        (option) =>
          option.value !== "ghostty" && availableEditors.includes(option.value as EditorId),
      ),
    [allOptions, availableEditors],
  );

  const effectiveEditor = editorOptions.some((option) => option.value === lastEditor)
    ? lastEditor
    : ((editorOptions[0]?.value ?? null) as EditorId | null);
  const primaryOption = editorOptions.find(({ value }) => value === effectiveEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? effectiveEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      localStorage.setItem(LAST_EDITOR_KEY, editor);
      setLastEditor(editor);
    },
    [effectiveEditor, openInCwd],
  );

  const openTarget = useCallback(
    (target: WorkspaceOpenTargetId) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      if (target === "ghostty") {
        void api.shell.openWorkspace(openInCwd, target);
        return;
      }

      openInEditor(target);
    },
    [openInCwd, openInEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !effectiveEditor) return;

      event.preventDefault();
      openInEditor(effectiveEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditor, keybindings, openInCwd, openInEditor]);

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!effectiveEditor || !openInCwd}
        onClick={() => openInEditor(effectiveEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @sm/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Open options"
              data-open-options-trigger="true"
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {openTargetOptions.length === 0 && <MenuItem disabled>No open targets found</MenuItem>}
          {openTargetOptions.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openTarget(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === effectiveEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
