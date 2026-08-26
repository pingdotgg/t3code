import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomCommand } from "../state/use-atom-command";
import {
  EditorId,
  ShellAction,
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import type { EnvMode } from "../components/BranchToolbar.logic";
import { resolveAndPersistPreferredEditor, usePreferredEditor } from "../editorPreferences";
import { shellEnvironment } from "../state/shell";
import { buildShellWorkspaceState } from "./shellWorkspaceState";

const isShellAction = Schema.is(ShellAction);
const isEditorId = Schema.is(EditorId);

export interface ShellWorkspaceBridgeProps {
  readonly threadRef: ScopedThreadRef;
  readonly projectTitle: string | null;
  readonly projectRoot: string | null;
  readonly openInCwd: string | null;
  readonly threadTitle: string;
  readonly isDraft: boolean;
  readonly envMode: EnvMode;
  readonly envModeChangeable: boolean;
  readonly startFromOrigin: boolean;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly canOpenPullRequest: boolean;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly preferredScriptId: string | null;
  readonly environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  readonly environmentChangeable: boolean;
  readonly onNewThread: () => void;
  readonly onRunScript: (script: ProjectScript) => void;
  readonly onEnvModeChange: (mode: EnvMode) => void;
  readonly onStartFromOriginChange: (enabled: boolean) => void;
  readonly onOpenPullRequest: ((number: number) => void) | undefined;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

/**
 * Mounted by ChatView when the Qt shell hosts the app. Publishes the
 * workspace strip (breadcrumb, checkout context, editors, scripts) and routes
 * workspace.* actions to ChatView's handlers. Opening in an editor uses the
 * same command and preference the HTML picker uses.
 */
export function ShellWorkspaceBridge(props: ShellWorkspaceBridgeProps) {
  const shell = window.t3Shell;
  const [preferredEditorId, setPreferredEditor] = usePreferredEditor(props.availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor);

  const state = useMemo(
    () =>
      buildShellWorkspaceState({
        threadKey: scopedThreadKey(props.threadRef),
        projectTitle: props.projectTitle,
        projectRoot: props.projectRoot,
        threadTitle: props.threadTitle,
        isDraft: props.isDraft,
        envMode: props.envMode,
        envModeChangeable: props.envModeChangeable,
        startFromOrigin: props.startFromOrigin,
        branch: props.branch,
        worktreePath: props.worktreePath,
        gitStatus: props.gitStatus,
        canOpenPullRequest: props.onOpenPullRequest !== undefined && props.canOpenPullRequest,
        availableEditors: props.availableEditors,
        preferredEditorId,
        scripts: props.scripts,
        preferredScriptId: props.preferredScriptId,
        environments: props.environments,
        activeEnvironmentId: props.threadRef.environmentId,
        environmentChangeable: props.environmentChangeable,
      }),
    [preferredEditorId, props],
  );

  useEffect(() => {
    if (!shell) return;
    void shell.publish("workspace", state);
  }, [shell, state]);
  // Leaving the route (settings, no thread) must not leave stale chrome behind.
  useEffect(() => {
    if (!shell) return;
    return () => {
      void shell.publish("workspace", null);
    };
  }, [shell]);

  const latest = useRef({ props, openInEditor, setPreferredEditor });
  latest.current = { props, openInEditor, setPreferredEditor };
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        const { props: current, openInEditor: open, setPreferredEditor: remember } = latest.current;
        switch (candidate.type) {
          case "workspace.newThread":
            current.onNewThread();
            return;
          case "workspace.openInEditor": {
            if (current.openInCwd === null) return;
            const editor =
              candidate.editorId !== undefined && isEditorId(candidate.editorId)
                ? candidate.editorId
                : resolveAndPersistPreferredEditor(current.availableEditors);
            if (editor === null || !current.availableEditors.includes(editor)) return;
            remember(editor);
            void open({
              environmentId: current.threadRef.environmentId,
              input: { cwd: current.openInCwd, editor },
            });
            return;
          }
          case "workspace.runScript": {
            const script = current.scripts.find((item) => item.id === candidate.scriptId);
            if (script) current.onRunScript(script);
            return;
          }
          case "workspace.envMode.set":
            if (current.envModeChangeable) current.onEnvModeChange(candidate.mode);
            return;
          case "workspace.startFromOrigin.set":
            if (current.envModeChangeable) current.onStartFromOriginChange(candidate.enabled);
            return;
          case "workspace.openPullRequest": {
            const number = current.gitStatus?.pr?.number;
            if (number !== undefined) current.onOpenPullRequest?.(number);
            return;
          }
          case "workspace.environment.set": {
            const target = current.environments.find(
              (environment) => environment.environmentId === candidate.environmentId,
            );
            if (target && current.environmentChangeable) {
              current.onEnvironmentChange(target.environmentId);
            }
            return;
          }
          default:
            return;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [shell]);

  return null;
}
