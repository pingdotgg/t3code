import {
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ServerVSCodeTunnel,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
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
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { readLocalApi } from "~/localApi";
import { stackedThreadToast, toastManager } from "../ui/toast";

type EditorPickerOption = { label: string; Icon: Icon; value: EditorId };
type VSCodeTunnelPickerOption = {
  label: string;
  Icon: Icon;
  value: "vscode-tunnel";
  vscodeTunnel: ServerVSCodeTunnel;
};
type PickerOption = EditorPickerOption | VSCodeTunnelPickerOption;

function isVSCodeTunnelOption(option: PickerOption): option is VSCodeTunnelPickerOption {
  return option.value === "vscode-tunnel";
}

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<EditorPickerOption> = [
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

function encodeVSCodeTunnelPath(cwd: string): string {
  const normalized = cwd.replaceAll("\\", "/");
  const hasLeadingSlash = normalized.startsWith("/");
  const encodedSegments = normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return hasLeadingSlash ? `/${encodedSegments}` : encodedSegments;
}

function buildVSCodeTunnelUrl(machineName: string, cwd: string): string {
  const encodedPath = encodeVSCodeTunnelPath(cwd);
  return `https://vscode.dev/tunnel/${encodeURIComponent(machineName)}/${encodedPath}`;
}

function buildVSCodeTunnelDesktopUrl(machineName: string, cwd: string): string {
  const encodedPath = encodeVSCodeTunnelPath(cwd);
  return `vscode://vscode-remote/tunnel+${encodeURIComponent(machineName)}/${encodedPath}`;
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  vscodeTunnel = null,
  openVSCodeRemoteTunnelsInDesktop = false,
  openInCwd,
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  vscodeTunnel?: ServerVSCodeTunnel | null;
  openVSCodeRemoteTunnelsInDesktop?: boolean;
  openInCwd: string | null;
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const [preferVSCodeTunnel, setPreferVSCodeTunnel] = useState(false);
  const latestEditorSelectionRef = useRef(0);
  const editorOptions = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const vscodeTunnelOption = useMemo<VSCodeTunnelPickerOption | null>(
    () =>
      vscodeTunnel && openInCwd
        ? {
            label: `VS Code Tunnel (${vscodeTunnel.machineName})`,
            Icon: VisualStudioCode,
            value: "vscode-tunnel",
            vscodeTunnel,
          }
        : null,
    [openInCwd, vscodeTunnel],
  );
  const options = useMemo(
    () => (vscodeTunnelOption ? [...editorOptions, vscodeTunnelOption] : editorOptions),
    [editorOptions, vscodeTunnelOption],
  );
  const primaryOption =
    (preferVSCodeTunnel ? vscodeTunnelOption : null) ??
    editorOptions.find(({ value }) => value === preferredEditor) ??
    (editorOptions.length === 0 ? vscodeTunnelOption : null);

  useEffect(() => {
    if (!vscodeTunnelOption && preferVSCodeTunnel) {
      setPreferVSCodeTunnel(false);
    }
  }, [preferVSCodeTunnel, vscodeTunnelOption]);

  const openOption = useCallback(
    (option: PickerOption | null) => {
      if (!openInCwd || !option) return;
      if (isVSCodeTunnelOption(option)) {
        latestEditorSelectionRef.current += 1;
        const editorSelectionVersion = latestEditorSelectionRef.current;
        const url = openVSCodeRemoteTunnelsInDesktop
          ? buildVSCodeTunnelDesktopUrl(option.vscodeTunnel.machineName, openInCwd)
          : buildVSCodeTunnelUrl(option.vscodeTunnel.machineName, openInCwd);
        const localApi = readLocalApi();
        if (!localApi) {
          setPreferVSCodeTunnel(false);
          toastManager.add({
            type: "error",
            title: "Link opening is unavailable.",
          });
          return;
        }
        void localApi.shell
          .openExternal(url)
          .then(() => {
            if (latestEditorSelectionRef.current !== editorSelectionVersion) return;
            setPreferVSCodeTunnel(true);
          })
          .catch((error) => {
            if (latestEditorSelectionRef.current !== editorSelectionVersion) return;
            setPreferVSCodeTunnel(false);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open tunnel link",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          });
        return;
      }

      const editor = option.value;
      latestEditorSelectionRef.current += 1;
      setPreferVSCodeTunnel(false);
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
    [
      environmentId,
      openInCwd,
      openInEditorMutation,
      openVSCodeRemoteTunnelsInDesktop,
      setPreferredEditor,
    ],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!primaryOption) return;

      e.preventDefault();
      void openOption(primaryOption);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableShortcut, keybindings, openInCwd, openOption, primaryOption]);

  return (
    <Group aria-label="Open in editor">
      <Button
        aria-label={compact ? "Open file in preferred editor" : undefined}
        size="xs"
        variant="outline"
        disabled={!primaryOption || !openInCwd}
        onClick={() => openOption(primaryOption)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Open
        </span>
      </Button>
      <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={compact ? "Choose editor" : "Copy options"}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No editors available</MenuItem>}
          {options.map((option) => (
            <MenuItem key={option.value} onClick={() => openOption(option)}>
              {(() => {
                const Icon = option.Icon;
                return <Icon aria-hidden="true" className="text-muted-foreground" />;
              })()}
              {option.label}
              {!isVSCodeTunnelOption(option) &&
                option.value === preferredEditor &&
                openFavoriteEditorShortcutLabel && (
                  <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
