import { scopeThreadRef } from "@forma/client-runtime";
import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@forma/contracts";
import { IconEllipsis as EllipsisIcon } from "symbols-react";

import { type DraftId } from "~/composerDraftStore";

import GitActionsControl from "../GitActionsControl";
import { HeaderIconActionButton } from "../HeaderIconActionButton";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
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
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  workspaceRoot: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onCopyThreadAsMarkdown: () => void;
  onCopyWorkspacePath?: (() => void) | undefined;
  onCopyThreadId?: (() => void) | undefined;
  onForkThread?: (() => void) | undefined;
  onArchiveThread?: (() => void) | undefined;
  onDeleteThread?: (() => void) | undefined;
}

export function ChatHeaderActionsMenu({
  routeKind,
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  gitCwd,
  workspaceRoot,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onCopyThreadAsMarkdown,
  onCopyWorkspacePath,
  onCopyThreadId,
  onForkThread,
  onArchiveThread,
  onDeleteThread,
}: ChatHeaderActionsMenuProps) {
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const hasWorkspaceOpenTargets = openInCwd !== null;
  const hasProjectActions = activeProjectScripts !== undefined;
  const hasGitActions = gitCwd !== null;

  return (
    <Menu>
      <MenuTrigger
        render={<HeaderIconActionButton aria-label="More actions" title="More actions" />}
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52" keepMounted>
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          {hasProjectActions ? (
            <>
              <ProjectScriptsControl
                renderMode="menu-items"
                scripts={activeProjectScripts}
                keybindings={keybindings}
                preferredScriptId={preferredScriptId}
                onRunScript={onRunProjectScript}
                onAddScript={onAddProjectScript}
                onUpdateScript={onUpdateProjectScript}
                onDeleteScript={onDeleteProjectScript}
              />
              {hasWorkspaceOpenTargets || hasGitActions ? <MenuSeparator /> : null}
            </>
          ) : null}
          {hasWorkspaceOpenTargets ? (
            <>
              <OpenInMenuItems
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
              {hasGitActions ? <MenuSeparator /> : null}
            </>
          ) : null}
          {hasGitActions ? (
            <GitActionsControl
              renderMode="menu-items"
              gitCwd={gitCwd}
              activeThreadRef={activeThreadRef}
              {...(draftId ? { draftId } : {})}
            />
          ) : null}
        </MenuGroup>

        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Thread</MenuGroupLabel>
          <MenuItem onClick={onCopyThreadAsMarkdown}>Copy thread as Markdown</MenuItem>
          {workspaceRoot && onCopyWorkspacePath ? (
            <MenuItem onClick={onCopyWorkspacePath}>Copy workspace path</MenuItem>
          ) : null}
          {routeKind === "server" && onCopyThreadId ? (
            <MenuItem onClick={onCopyThreadId}>Copy thread ID</MenuItem>
          ) : null}
          {routeKind === "server" && onForkThread ? (
            <MenuItem onClick={onForkThread}>Fork thread</MenuItem>
          ) : null}
          {routeKind === "server" && onArchiveThread ? (
            <MenuItem onClick={onArchiveThread}>Archive</MenuItem>
          ) : null}
          {routeKind === "server" && onDeleteThread ? (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={onDeleteThread}>
                Delete
              </MenuItem>
            </>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
