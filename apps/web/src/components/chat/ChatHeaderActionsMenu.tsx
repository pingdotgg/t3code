import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { FileDownIcon, FolderClosedIcon, GitForkIcon, HashIcon, Trash2Icon } from "lucide-react";
import type { RefObject } from "react";
import { IconEllipsis as EllipsisIcon } from "symbols-react";

import type { DraftId } from "~/composerDraftStore";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";

import GitActionsControl, { type GitActionsControlHandle } from "../GitActionsControl";
import { HeaderIconActionButton } from "../HeaderIconActionButton";
import { MessageCopyIcon, SidebarArchiveIcon } from "../icons/custom";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { OpenInMenuItems } from "./OpenInPicker";

interface ChatHeaderActionsMenuProps {
  routeKind: "server" | "draft";
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  gitActionsRef?: RefObject<GitActionsControlHandle | null> | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  workspaceRoot: string | null;
  showOpenIn: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onExportThread?: (() => void) | undefined;
  onCopyThreadAsMarkdown?: (() => void) | undefined;
  onCopyWorkspacePath?: (() => void) | undefined;
  onCopyThreadId?: (() => void) | undefined;
  onForkThread?: (() => void) | undefined;
  onArchiveThread?: (() => void) | undefined;
  onDeleteThread?: (() => void) | undefined;
}

export function resolveChatHeaderActionVisibility(input: {
  routeKind: "server" | "draft";
  hasProjectActions: boolean;
  hasOpenInCwd: boolean;
  showOpenIn: boolean;
  hasGitCwd: boolean;
  hasWorkspaceRoot: boolean;
}) {
  const hasOpenInActions = input.showOpenIn && input.hasOpenInCwd;
  const hasWorkspaceActions = input.hasProjectActions || hasOpenInActions || input.hasGitCwd;
  return {
    hasOpenInActions,
    hasWorkspaceActions,
    showDurableThreadActions: input.routeKind === "server",
    showWorkspacePath: input.hasWorkspaceRoot,
  } as const;
}

export function ChatHeaderActionsMenu({
  routeKind,
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  gitActionsRef,
  availableEditors,
  gitCwd,
  workspaceRoot,
  showOpenIn,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  onCopyThreadAsMarkdown,
  onCopyWorkspacePath,
  onCopyThreadId,
  onForkThread,
  onArchiveThread,
  onDeleteThread,
}: ChatHeaderActionsMenuProps) {
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const hasProjectActions = activeProjectScripts !== undefined;
  const hasGitActions = gitCwd !== null;
  const visibility = resolveChatHeaderActionVisibility({
    routeKind,
    hasProjectActions,
    hasOpenInCwd: openInCwd !== null,
    showOpenIn,
    hasGitCwd: hasGitActions,
    hasWorkspaceRoot: workspaceRoot !== null,
  });
  const { hasOpenInActions, hasWorkspaceActions } = visibility;
  const hasDurableThreadActions =
    routeKind === "server" &&
    Boolean(
      onExportThread ||
      onCopyThreadAsMarkdown ||
      onCopyThreadId ||
      onForkThread ||
      onArchiveThread ||
      onDeleteThread,
    );
  const hasThreadActions = hasDurableThreadActions || Boolean(workspaceRoot && onCopyWorkspacePath);

  return (
    <Menu>
      <MenuTrigger
        render={<HeaderIconActionButton aria-label="More actions" title="More actions" />}
      >
        <EllipsisIcon className="size-3 rotate-90" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56 max-w-[calc(100vw-1rem)]" keepMounted>
        {hasWorkspaceActions ? (
          <MenuGroup>
            <MenuGroupLabel>Workspace</MenuGroupLabel>
            {hasProjectActions ? (
              <ProjectScriptsControl
                renderMode="menu-items"
                scripts={activeProjectScripts}
                fileScripts={fileScripts}
                keybindings={keybindings}
                preferredScriptId={preferredScriptId}
                onRunScript={onRunProjectScript}
                onAddScript={onAddProjectScript}
                onUpdateScript={onUpdateProjectScript}
                onDeleteScript={onDeleteProjectScript}
              />
            ) : null}
            {hasProjectActions && (hasOpenInActions || hasGitActions) ? <MenuSeparator /> : null}
            {hasOpenInActions ? (
              <OpenInMenuItems
                environmentId={activeThreadEnvironmentId}
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            ) : null}
            {hasOpenInActions && hasGitActions ? <MenuSeparator /> : null}
            {hasGitActions ? (
              <GitActionsControl
                ref={gitActionsRef}
                renderMode="menu-items"
                gitCwd={gitCwd}
                activeThreadRef={activeThreadRef}
                keybindings={keybindings}
                {...(draftId ? { draftId } : {})}
              />
            ) : null}
          </MenuGroup>
        ) : null}

        {hasWorkspaceActions && hasThreadActions ? <MenuSeparator /> : null}
        {hasThreadActions ? (
          <MenuGroup>
            <MenuGroupLabel>Thread</MenuGroupLabel>
            {routeKind === "server" && onExportThread ? (
              <MenuItem onClick={onExportThread}>
                <FileDownIcon />
                Export as Markdown
              </MenuItem>
            ) : null}
            {routeKind === "server" && onCopyThreadAsMarkdown ? (
              <MenuItem onClick={onCopyThreadAsMarkdown}>
                <MessageCopyIcon />
                Copy thread as Markdown
              </MenuItem>
            ) : null}
            {workspaceRoot && onCopyWorkspacePath ? (
              <MenuItem onClick={onCopyWorkspacePath}>
                <FolderClosedIcon />
                Copy workspace path
              </MenuItem>
            ) : null}
            {routeKind === "server" && onCopyThreadId ? (
              <MenuItem onClick={onCopyThreadId}>
                <HashIcon />
                Copy thread ID
              </MenuItem>
            ) : null}
            {routeKind === "server" && onForkThread ? (
              <MenuItem onClick={onForkThread}>
                <GitForkIcon />
                Fork thread
              </MenuItem>
            ) : null}
            {routeKind === "server" && onArchiveThread ? (
              <MenuItem onClick={onArchiveThread}>
                <SidebarArchiveIcon />
                Archive
              </MenuItem>
            ) : null}
            {routeKind === "server" && onDeleteThread ? (
              <>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={onDeleteThread}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </>
            ) : null}
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
