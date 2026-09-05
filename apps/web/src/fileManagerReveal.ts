import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { resolveRemoteOpenState } from "./remoteOpen";
import {
  fileManagerRevealNameForKind,
  fileManagerRevealNameForOs,
  fileManagerOpenNameForOs,
  type FileManagerOpenName,
  type FileManagerRevealName,
  revealInFileExplorerLabelForManager,
} from "./components/preview/fileExplorerLabel";
import { environmentPresentations } from "./state/presentation";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

export type FileManagerActionResult = Awaited<ReturnType<typeof shellEnvironment.openInEditor.run>>;

interface FileManagerRevealAction {
  readonly label: string;
  readonly run: (targetPath: string) => Promise<FileManagerActionResult>;
}

interface FileManagerOpenAction {
  readonly managerName: FileManagerOpenName;
  readonly run: (targetPath: string) => Promise<FileManagerActionResult>;
}

export interface FileManagerAction {
  readonly open: FileManagerOpenAction;
  readonly reveal: FileManagerRevealAction | null;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function usesWindowsSeparators(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

function trimTrailingSeparators(path: string, separator: "/" | "\\"): string {
  const trimmed = separator === "/" ? path.replace(/\/+$/, "") : path.replace(/[\\/]+$/, "");
  return trimmed || separator;
}

function windowsVolumeRootForWorkspaceRoot(workspaceRoot: string): string | null {
  const normalizedRoot = workspaceRoot.replaceAll("/", "\\");
  const drive = /^([A-Za-z]:)(?:\\|$)/.exec(normalizedRoot);
  if (drive !== null) return drive[1] ?? null;

  if (!normalizedRoot.startsWith("\\\\")) return null;
  const [server, share] = normalizedRoot.slice(2).split("\\");
  return server && share ? `\\\\${server}\\${share}` : null;
}

/** Resolves a literal file-tree path without interpreting terminal-link syntax. */
export function resolveLiteralFilePath(path: string, workspaceRoot: string): string {
  const windowsVolumeRoot = windowsVolumeRootForWorkspaceRoot(workspaceRoot);
  if (
    windowsVolumeRoot !== null &&
    /^[\\/]/.test(path) &&
    !path.startsWith("\\\\") &&
    !path.startsWith("//")
  ) {
    return `${windowsVolumeRoot}\\${path.replace(/^[\\/]+/, "").replaceAll("/", "\\")}`;
  }
  if (isAbsoluteFilePath(path)) return path;

  const separator: "/" | "\\" = usesWindowsSeparators(workspaceRoot) ? "\\" : "/";
  const root = trimTrailingSeparators(workspaceRoot, separator).replaceAll("/", separator);
  const relativePath = separator === "\\" ? path.replaceAll("/", "\\") : path;
  return root === separator ? `${root}${relativePath}` : `${root}${separator}${relativePath}`;
}

const EMPTY_FILE_MANAGER_OPEN_NAME_ATOM = Atom.make<FileManagerOpenName | null>(null).pipe(
  Atom.withLabel("web-file-manager-open-name:empty"),
);
const EMPTY_FILE_MANAGER_REVEAL_NAME_ATOM = Atom.make<FileManagerRevealName | null>(null).pipe(
  Atom.withLabel("web-file-manager-reveal-name:empty"),
);

type FileManagerPresentation = Pick<EnvironmentPresentation, "entry"> & {
  readonly serverConfig:
    | (Pick<
        ServerConfig,
        | "availableEditors"
        | "remoteOpenTargets"
        | "shellRevealInFileManager"
        | "shellRevealInFileManagerKind"
      > & {
        readonly environment: {
          readonly platform: Pick<ServerConfig["environment"]["platform"], "os">;
        };
      })
    | null;
};

function sshAliasForPresentation(presentation: FileManagerPresentation): string | null {
  const profile = Option.getOrNull(presentation.entry.profile);
  return profile !== null && profile._tag === "SshConnectionProfile" ? profile.target.alias : null;
}

function isLocalEnvironment(presentation: FileManagerPresentation): boolean {
  const remoteOpenState = resolveRemoteOpenState({
    target: presentation.entry.target,
    sshAlias: sshAliasForPresentation(presentation),
    remoteOpenTargets: presentation.serverConfig?.remoteOpenTargets,
    isDesktopRenderer: typeof window !== "undefined" && window.desktopBridge !== undefined,
  });
  return remoteOpenState.mode === "local-exec";
}

function fileManagerOpenNameForPresentation(
  presentation: FileManagerPresentation,
): FileManagerOpenName | null {
  const serverConfig = presentation.serverConfig;
  if (
    serverConfig === null ||
    !serverConfig.availableEditors.includes("file-manager") ||
    !isLocalEnvironment(presentation)
  ) {
    return null;
  }

  return fileManagerOpenNameForOs(serverConfig.environment.platform.os);
}

function fileManagerRevealNameForPresentation(
  presentation: FileManagerPresentation,
): FileManagerRevealName | null {
  const serverConfig = presentation.serverConfig;
  if (
    fileManagerOpenNameForPresentation(presentation) === null ||
    serverConfig?.shellRevealInFileManager !== true
  ) {
    return null;
  }

  return serverConfig.shellRevealInFileManagerKind === undefined
    ? fileManagerRevealNameForOs(serverConfig.environment.platform.os)
    : fileManagerRevealNameForKind(serverConfig.shellRevealInFileManagerKind);
}

function createFileManagerAction(
  environmentId: EnvironmentId,
  openManagerName: FileManagerOpenName,
  revealManagerName: FileManagerRevealName | null,
  openInEditor: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly editor: "file-manager";
      readonly reveal?: true;
    };
  }) => Promise<FileManagerActionResult>,
): FileManagerAction {
  const reveal =
    revealManagerName === null
      ? null
      : {
          label: revealInFileExplorerLabelForManager(revealManagerName),
          run: (targetPath: string) =>
            openInEditor({
              environmentId,
              input: { cwd: targetPath, editor: "file-manager", reveal: true },
            }),
        };

  return {
    open: {
      managerName: openManagerName,
      run: (targetPath) =>
        openInEditor({
          environmentId,
          input: { cwd: targetPath, editor: "file-manager" },
        }),
    },
    reveal,
  };
}

export function fileManagerActionForPresentation(
  environmentId: EnvironmentId,
  presentation: FileManagerPresentation,
  openInEditor: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly editor: "file-manager";
      readonly reveal?: true;
    };
  }) => Promise<FileManagerActionResult>,
): FileManagerAction | null {
  const openManagerName = fileManagerOpenNameForPresentation(presentation);
  if (openManagerName === null) {
    return null;
  }
  return createFileManagerAction(
    environmentId,
    openManagerName,
    fileManagerRevealNameForPresentation(presentation),
    openInEditor,
  );
}

const openManagerNameAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    return presentation === null ? null : fileManagerOpenNameForPresentation(presentation);
  }).pipe(Atom.withLabel(`web-file-manager-open-name:${environmentId}`)),
);
const revealManagerNameAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    return presentation === null ? null : fileManagerRevealNameForPresentation(presentation);
  }).pipe(Atom.withLabel(`web-file-manager-reveal-name:${environmentId}`)),
);

export function useFileManagerActionForEnvironment(
  environmentId: EnvironmentId | null,
): FileManagerAction | null {
  const openManagerName = useAtomValue(
    environmentId === null ? EMPTY_FILE_MANAGER_OPEN_NAME_ATOM : openManagerNameAtom(environmentId),
  );
  const revealManagerName = useAtomValue(
    environmentId === null
      ? EMPTY_FILE_MANAGER_REVEAL_NAME_ATOM
      : revealManagerNameAtom(environmentId),
  );
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });

  return useMemo(
    () =>
      environmentId === null || openManagerName === null
        ? null
        : createFileManagerAction(environmentId, openManagerName, revealManagerName, openInEditor),
    [environmentId, openInEditor, openManagerName, revealManagerName],
  );
}

export function useFileManagerAction(): (environmentId: EnvironmentId) => FileManagerAction | null {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const actionsByEnvironment = useMemo(() => {
    const actions = new Map<EnvironmentId, FileManagerAction | null>();
    for (const [environmentId, presentation] of presentations ?? []) {
      actions.set(
        environmentId,
        fileManagerActionForPresentation(environmentId, presentation, openInEditor),
      );
    }
    return actions;
  }, [openInEditor, presentations]);

  return useCallback(
    (environmentId: EnvironmentId) => actionsByEnvironment.get(environmentId) ?? null,
    [actionsByEnvironment],
  );
}
