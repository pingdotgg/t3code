import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
  type ContextMenuSource,
} from "@t3tools/contracts";

import { contextMenuSourceOf } from "./contextMenuSource";
import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { useEditorMenuIcons } from "./editorMenuIcons";
import { readLocalApi } from "./localApi";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenResolution,
} from "./remoteOpen";
import { serverEnvironment } from "./state/server";
import { useEnvironmentScope } from "./state/session";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";

import type { MessageResolver } from "./i18n/messages";

export type FileContextMenuAction =
  | "reveal-in-folder"
  | "open"
  /** Submenu parent; never the activated id. */
  | "open-with"
  | `editor:${EditorId}`;

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly isDirectory?: boolean;
}

export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
  readonly editorIcons: ReadonlyMap<EditorId, string>;
  readonly resolve: MessageResolver;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  if (!input.hasAbsolutePath) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({
      id: "open",
      label: input.resolve(msg("Open", { $context: "verb, opens a file" })),
      icon: "pencil",
    });
  }
  if (input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: input.resolve(msg("Open with")),
      children: editorIds.map((editorId) => {
        const iconImage = input.editorIcons.get(editorId);
        return {
          id: `editor:${editorId}` as FileContextMenuAction,
          label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
          ...(iconImage === undefined ? {} : { iconImage }),
        };
      }),
    });
  }
  return items;
}

export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const resolve = useMessages();

  const remoteOpen = useRemoteOpenResolution(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const mode = environmentId !== null && remoteOpen.isResolved ? remoteOpen.state.mode : null;
  // Shell actions run on the server host, which is the viewer's machine only in local-exec.
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isLocalExec = mode === "local-exec" && canOperateHost;
  const remoteHost = remoteOpen.state.mode === "remote-links" ? remoteOpen.state.host : null;

  const availableEditors = isLocalExec
    ? (serverConfig?.availableEditors ?? [])
    : mode === "remote-links"
      ? remoteCapableEditors
      : [];
  const capabilities: FileContextMenuCapabilities = {
    // WSL can reveal in Windows Explorer despite reporting Linux; use server wording.
    revealLabel:
      isLocalExec &&
      serverConfig?.shellRevealInFileManager === true &&
      serverConfig.availableEditors.includes("file-manager")
        ? serverConfig.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os, resolve)
          : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind, resolve)
        : undefined,
    canOpenDefault: isLocalExec && availableEditors.includes("file-manager"),
    editorIds: availableEditors,
  };
  const editorIcons = useEditorMenuIcons(availableEditors);

  const editorFailureTitle = (editor: EditorId) =>
    resolve(
      msg("Could not open in {editor}", {
        editor: EDITOR_LABEL_BY_ID.get(editor) ?? editor,
      }),
    );

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    const absolutePath = resolveFileContextMenuAbsolutePath(target);
    if (absolutePath === null || environmentId === null) return;

    const reveal = action === "reveal-in-folder";
    const editor =
      action === "open" || reveal
        ? ("file-manager" as const)
        : (action.slice("editor:".length) as EditorId);
    if (action === "open" && !capabilities.canOpenDefault) return;
    if (reveal && capabilities.revealLabel === undefined) return;
    if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

    if (remoteHost !== null) {
      const url = buildRemoteOpenUrl({
        editor,
        ...remoteHost,
        absolutePath,
        isFile: target.isDirectory !== true,
      });
      if (url !== undefined && (await openRemoteEditorUrl(url))) return;
      toastManager.add({
        type: "error",
        title: editorFailureTitle(editor),
        description: absolutePath,
      });
      return;
    }

    const result = await openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title:
        action === "open"
          ? resolve(msg("Could not open file"))
          : reveal
            ? resolve(msg("Unable to reveal file"))
            : editorFailureTitle(editor),
      description: absolutePath,
    });
  };

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
    source?: ContextMenuSource,
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildFileContextMenuItems({
      hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
      capabilities,
      editorIcons,
      resolve,
    });
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position, source);
    if (clicked === null) return;
    await activate(clicked as FileContextMenuAction, target);
  };

  return {
    buildItems: (target: FileContextMenuTarget) =>
      buildFileContextMenuItems({
        hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
        capabilities,
        editorIcons,
        resolve,
      }),
    capabilities,
    activate,
    show,
  };
}

export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return (
    target: FileContextMenuTarget,
    event?: Pick<MouseEvent, "type" | "button" | "detail" | "clientX" | "clientY">,
  ) => {
    void contextMenu.show(
      target,
      event ? { x: event.clientX, y: event.clientY } : undefined,
      event ? contextMenuSourceOf(event) : undefined,
    );
  };
}
