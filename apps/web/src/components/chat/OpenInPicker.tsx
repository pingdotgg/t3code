import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import type { FileManagerAction } from "./OpenInPicker.logic";
import { OPEN_FAVORITE_EDITOR_ATTRIBUTE } from "./OpenInPickerShortcut";
import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import type { MessageResolver } from "../../i18n/messages";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type EditorIconOption, editorIconOptions } from "../editorIcons";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = EditorIconOption & { label: string };

const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
  resolve: MessageResolver,
): ReadonlyArray<OpenInOption> => {
  const availableEditorSet = new Set(availableEditors);
  return editorIconOptions(platform)
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({
      ...option,
      label: editorLabelForPlatform(option.value, platform, resolve),
    }));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  openInCwdIsFile = false,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  fileManagerAction = "open",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  openInCwdIsFile?: boolean;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  fileManagerAction?: FileManagerAction;
}) {
  const gt = useGT();
  const messages = useMessages();
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied = remote.mode === "local-exec" && !canOperateHost;
  const canOpenEditor = remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  // Remote editors run on the viewing machine; only desktop can probe that PATH.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const isEditorUnavailable = (editor: EditorId | null) =>
    editor === "file-manager" && fileManagerAction === "unavailable";

  const openInEditor = async (editorId: EditorId | null): Promise<boolean> => {
    if (!openInCwd) return false;
    const editor = editorId ?? preferredEditor;
    if (!editor || isEditorUnavailable(editor)) return false;
    if (remote.mode === "remote-unavailable") return false;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        ...remote.host,
        absolutePath: openInCwd,
        isFile: openInCwdIsFile,
      });
      if (url === undefined) return false;
      // Only record hint-seen/preferred when the shell actually accepted
      // the URL (an older desktop build can refuse the editor scheme).
      const opened = await openRemoteEditorUrl(url);
      if (!opened) return false;
      markRemoteHintSeen();
      setPreferredEditor(editor);
      return true;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const result = openInEditorMutation({
      environmentId,
      input: {
        cwd: openInCwd,
        editor,
        ...(fileManagerAction === "reveal" && editor === "file-manager" ? { reveal: true } : {}),
      },
    });
    setPreferredEditor(editor);
    return (await result)._tag === "Success";
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const options = resolveOpenInOptions(navigator.platform, effectiveEditors, messages);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const primaryLabel = isPanel
    ? primaryOption
      ? gt("Open in {editor}", { editor: primaryOption.label })
      : gt("Open in editor")
    : gt("Open", { $context: "verb, opens the project in the preferred editor" });

  const unavailableReason =
    remote.mode === "remote-unavailable"
      ? environmentLabel !== null
        ? gt("No SSH route to {environment}", { environment: environmentLabel })
        : gt("No SSH route to this machine")
      : remote.mode === "remote-links" && options.length === 0
        ? environmentLabel !== null
          ? gt("Open from a computer to edit on {environment}", { environment: environmentLabel })
          : gt("Open from a computer to edit on this machine")
        : null;

  const editorItems = (
    <>
      {unavailableReason !== null ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          {unavailableReason}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              <T>No installed editors found</T>
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={
                !openInCwd ||
                !canOpenEditor ||
                (presentation === "menu" && isEditorUnavailable(value))
              }
              key={value}
              onClick={() => {
                if (presentation === "menu") {
                  void openInEditor(value);
                } else {
                  setPreferredEditor(value);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              {environmentLabel !== null
                ? gt("Opens over SSH. Needs your key on {environment}", {
                    environment: environmentLabel,
                  })
                : gt("Opens over SSH. Needs your key on this machine")}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            disabled={!openInCwd || !canOpenEditor || isEditorUnavailable(preferredEditor)}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>
              <T>
                Open in <Var>{primaryOption.label}</Var>
              </T>
            </MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>
              <T>Open in…</T>
            </MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  const primaryControlLabel = compact ? gt("Open file in preferred editor") : primaryLabel;
  const primaryControl = (
    <ThreadDetailsControl
      aria-label={primaryControlLabel}
      // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
      data-toolbar-control=""
      size={isPanel ? "sm" : "xs"}
      variant={isPanel ? "ghost" : "outline"}
      part="primary"
      panel={isPanel}
      disabled={
        !preferredEditor || !openInCwd || !canOpenEditor || isEditorUnavailable(preferredEditor)
      }
      {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
      onClick={() => {
        if (!preferredEditor) return;
        const label = editorLabelForPlatform(preferredEditor, navigator.platform);
        void openInEditor(preferredEditor).then((opened) => {
          if (opened) announce(gt("Opened in {editor}", { editor: label }));
        });
      }}
    >
      {primaryOption?.Icon ? (
        <primaryOption.Icon
          aria-hidden="true"
          className={cn(
            isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
            getOpenInIconClass(primaryOption.kind),
          )}
        />
      ) : isPanel ? (
        <SquareArrowOutUpRightIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ) : null}
      <span
        className={cn(
          compact
            ? "sr-only"
            : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
          isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
        )}
      >
        {primaryLabel}
      </span>
    </ThreadDetailsControl>
  );

  return (
    <ActionGroup
      aria-label={gt("Open in editor")}
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <Tooltip>
        <TooltipTrigger render={primaryControl} />
        <TooltipPopup side="top">{primaryControlLabel}</TooltipPopup>
      </Tooltip>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={isHostEditorDenied}
                render={
                  <ThreadDetailsControl
                    aria-label={gt("Choose editor")}
                    data-toolbar-control=""
                    size={isPanel ? "sm" : "icon-xs"}
                    variant={isPanel ? "ghost" : "outline"}
                    part="secondary"
                    panel={isPanel}
                  />
                }
              />
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T>Choose editor</T>
          </TooltipPopup>
        </Tooltip>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
