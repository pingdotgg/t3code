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
import { useEffect, useMemo, useRef, useState } from "react";

import { useShellPublish } from "./useShellPublish";

import type { EnvMode } from "../components/BranchToolbar.logic";
import { type DraftId } from "../composerDraftStore";
import { resolveAndPersistPreferredEditor, usePreferredEditor } from "../editorPreferences";
import { useRenameThread } from "../hooks/useRenameThread";
import { useThreadBranchSelection } from "../hooks/useThreadBranchSelection";
import { parsePullRequestReference } from "../pullRequestReference";
import { subscribeShellRenameRequests } from "./shellRenameRequest";
import { shellEnvironment } from "../state/shell";
import { buildShellWorkspaceState } from "./shellWorkspaceState";

const isShellAction = Schema.is(ShellAction);
const isEditorId = Schema.is(EditorId);

export interface ShellWorkspaceBridgeProps {
  readonly threadRef: ScopedThreadRef;
  readonly draftId: DraftId | undefined;
  readonly envLocked: boolean;
  /** Set while a started server thread may still change its checkout (see ChatView). */
  readonly effectiveEnvModeOverride: EnvMode | undefined;
  readonly activeThreadBranchOverride: string | null | undefined;
  readonly onActiveThreadBranchOverrideChange: ((branch: string | null) => void) | undefined;
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
  /** Set on draft threads: a PR number or URL in the branch picker checks it out. */
  readonly onCheckoutPullRequestRequest: ((reference: string) => void) | undefined;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly renameRequestId: number;
  readonly onTitleMenu: (x: number, y: number) => void;
  readonly onRenameRequested: () => void;
  readonly threadTitleForRename: string;
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
  const [branchQuery, setBranchQuery] = useState("");
  const renameThread = useRenameThread({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
    currentTitle: props.threadTitleForRename,
  });
  // A sidebar row's "Rename" navigates here first, then asks for the editor.
  const threadKey = scopedThreadKey(props.threadRef);
  const onRenameRequestedRef = useRef(props.onRenameRequested);
  onRenameRequestedRef.current = props.onRenameRequested;
  useEffect(
    () => subscribeShellRenameRequests(threadKey, () => onRenameRequestedRef.current()),
    [threadKey],
  );
  const branchSelection = useThreadBranchSelection({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
    draftId: props.draftId,
    envLocked: props.envLocked,
    effectiveEnvModeOverride: props.effectiveEnvModeOverride,
    activeThreadBranchOverride: props.activeThreadBranchOverride,
    onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange,
    branchQuery,
  });
  const {
    refs,
    branchRefState,
    isInitialBranchesLoadPending,
    isBranchActionPending,
    branchByName,
    branchCwd,
  } = branchSelection;

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
        renameRequestId: props.renameRequestId,
        branchQuery,
        branches: refs,
        branchesTotal: branchRefState.data?.totalCount ?? refs.length,
        branchesLoading: isInitialBranchesLoadPending,
        branchSwitchPending: isBranchActionPending,
        // Switching stops a live session first (see useThreadBranchSelection),
        // so a started thread can still change its checkout.
        branchChangeable: branchCwd !== null,
      }),
    [
      branchCwd,
      branchQuery,
      branchRefState.data?.totalCount,
      isBranchActionPending,
      isInitialBranchesLoadPending,
      preferredEditorId,
      props,
      refs,
    ],
  );

  useShellPublish("workspace", state);

  const latest = useRef({
    props,
    openInEditor,
    setPreferredEditor,
    branchSelection,
    branchByName,
    renameThread,
  });
  latest.current = {
    props,
    openInEditor,
    setPreferredEditor,
    branchSelection,
    branchByName,
    renameThread,
  };
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
        const {
          props: current,
          openInEditor: open,
          setPreferredEditor: remember,
          branchSelection: branches,
          branchByName: refByName,
          renameThread: rename,
        } = latest.current;
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
          case "workspace.titleMenu":
            current.onTitleMenu(candidate.x, candidate.y);
            return;
          case "workspace.rename":
            rename(candidate.title);
            return;
          case "workspace.branch.search":
            setBranchQuery(candidate.query);
            return;
          case "workspace.branch.select": {
            const ref = refByName.get(candidate.name);
            if (ref) branches.selectBranch(ref);
            return;
          }
          case "workspace.branch.create": {
            const prReference = parsePullRequestReference(candidate.name);
            if (prReference !== null && current.onCheckoutPullRequestRequest) {
              current.onCheckoutPullRequestRequest(prReference);
              return;
            }
            branches.createRef(candidate.name);
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
