import { EDITORS, type EditorId, type ResolvedKeybindingsConfig } from "@repo/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";

import { CursorIcon, type Icon, VisualStudioCode, Zed } from "./Icons";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "~/keybindings";
import { readNativeApi } from "~/nativeApi";

const LAST_EDITOR_KEY = "t3code:last-editor";

interface OpenInPickerProps {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}

const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: OpenInPickerProps) {
  const [lastEditor, setLastEditor] = useState<EditorId>(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((editor) => editor.id === stored) ? (stored as EditorId) : EDITORS[0].id;
  });

  const allOptions = useMemo<Array<{ label: string; Icon: Icon; value: EditorId }>>(
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
  const options = useMemo(
    () => allOptions.filter((option) => availableEditors.includes(option.value)),
    [allOptions, availableEditors],
  );

  const effectiveEditor = options.some((option) => option.value === lastEditor)
    ? lastEditor
    : (options[0]?.value ?? null);
  const primaryOption = options.find((option) => option.value === effectiveEditor) ?? null;

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

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!api || !openInCwd || !effectiveEditor) return;

      event.preventDefault();
      void api.shell.openInEditor(openInCwd, effectiveEditor);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Open in editor">
      <Button
        size="xs"
        variant="outline"
        disabled={!effectiveEditor || !openInCwd}
        onClick={() => openInEditor(effectiveEditor)}
      >
        {primaryOption?.Icon ? (
          <primaryOption.Icon aria-hidden="true" className="size-3.5" />
        ) : null}
        <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @sm/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Open in editor options" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 ? <MenuItem disabled>No installed editors found</MenuItem> : null}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="size-3.5" />
              <span>{label}</span>
              {openFavoriteEditorShortcutLabel && value === effectiveEditor ? (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              ) : null}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});

export default OpenInPicker;
