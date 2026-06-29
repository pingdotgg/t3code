import { EditorId, type EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo, useCallback, useMemo } from "react";
import { shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
    },
    {
      label: "Kiro",
      Icon: KiroIcon,
      value: "kiro",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
    },
    {
      label: "VSCodium",
      Icon: VSCodium,
      value: "vscodium",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
    },
    {
      label: "IntelliJ IDEA",
      Icon: IntelliJIdeaIcon,
      value: "idea",
    },
    {
      label: "Aqua",
      Icon: AquaIcon,
      value: "aqua",
    },
    {
      label: "CLion",
      Icon: CLionIcon,
      value: "clion",
    },
    {
      label: "DataGrip",
      Icon: DataGripIcon,
      value: "datagrip",
    },
    {
      label: "DataSpell",
      Icon: DataSpellIcon,
      value: "dataspell",
    },
    {
      label: "GoLand",
      Icon: GoLandIcon,
      value: "goland",
    },
    {
      label: "PhpStorm",
      Icon: PhpStormIcon,
      value: "phpstorm",
    },
    {
      label: "PyCharm",
      Icon: PyCharmIcon,
      value: "pycharm",
    },
    {
      label: "Rider",
      Icon: RiderIcon,
      value: "rider",
    },
    {
      label: "RubyMine",
      Icon: RubyMineIcon,
      value: "rubymine",
    },
    {
      label: "RustRover",
      Icon: RustRoverIcon,
      value: "rustrover",
    },
    {
      label: "WebStorm",
      Icon: WebStormIcon,
      value: "webstorm",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions.filter((option) => availableEditorSet.has(option.value));
};

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  compact = false,
  displayMode = "toolbar",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  compact?: boolean;
  displayMode?: "toolbar" | "panel";
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      if (!openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      const result = openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor,
        },
      });
      setPreferredEditor(editor);
      return result;
    },
    [environmentId, openInCwd, openInEditorMutation, preferredEditor, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );
  const primaryLabel = isPanel ? `Open in ${primaryOption?.label ?? "editor"}` : "Open";

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS } : {})}
    >
      <Button
        aria-label={compact ? "Open file in preferred editor" : primaryLabel}
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        className={isPanel ? THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS : undefined}
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5"}
          />
        )}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && "not-sr-only ml-0.5 min-w-0 truncate",
          )}
        >
          {primaryLabel}
        </span>
      </Button>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Choose editor"
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              className={isPanel ? THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS : undefined}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
