import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { AlertTriangleIcon, XIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

interface VersionMismatchIssue {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverLabel: string;
}

export interface ThreadDetailsPanelProps {
  mode: "inline" | "popover";
  onClose?: () => void;
  environmentId: EnvironmentId;
  environmentConnection: EnvironmentConnectionPresentation | null;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onReconnectEnvironment: () => void;
  onOpenConnectionSettings: () => void;
  versionMismatch: VersionMismatchIssue | null;
  onDismissVersionMismatch: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const connectionIssue =
    props.environmentConnection !== null &&
    props.environmentConnection.phase !== "connected" &&
    props.environmentConnection.phase !== "available";
  const isReconnecting =
    props.environmentConnection?.phase === "connecting" ||
    props.environmentConnection?.phase === "reconnecting";
  const branchToolbarProps = {
    environmentId: props.environmentId,
    threadId: props.threadId,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    ...(props.effectiveEnvModeOverride
      ? { effectiveEnvModeOverride: props.effectiveEnvModeOverride }
      : {}),
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  const card = (
    <div
      className={cn(
        "floating-glass-surface overflow-x-hidden rounded-[20px] border border-border",
        props.mode === "inline"
          ? "max-h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "max-h-[calc(100dvh-6.5rem)] overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
      data-thread-details-card
    >
      <section aria-labelledby="thread-details-workspace-heading">
        <div className="flex min-h-10 items-center justify-between gap-3 px-3.5 pb-1 pt-3">
          <h3
            id="thread-details-workspace-heading"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Workspace
          </h3>
        </div>

        {connectionIssue ? (
          <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
            <div className="flex gap-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">Environment unavailable</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {props.environmentConnection?.error ??
                    "Reconnect this environment before sending messages or running actions."}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button
                    size="xs"
                    disabled={isReconnecting}
                    onClick={props.onReconnectEnvironment}
                  >
                    {isReconnecting ? "Reconnecting..." : "Reconnect"}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={props.onOpenConnectionSettings}>
                    Connections
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {props.versionMismatch ? (
          <div className="mx-3 mb-2 flex gap-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">Client and server versions differ</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Client {props.versionMismatch.clientVersion} · {props.versionMismatch.serverLabel}{" "}
                {props.versionMismatch.serverVersion}
              </p>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss version mismatch warning"
              onClick={props.onDismissVersionMismatch}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col px-2 pb-2.5">
          {props.availableEnvironments.length > 1 ? (
            <BranchToolbarEnvironmentSelector
              displayMode="panel"
              envLocked={props.envLocked}
              environmentId={props.environmentId}
              availableEnvironments={props.availableEnvironments}
              onEnvironmentChange={props.onEnvironmentChange}
            />
          ) : null}

          <BranchToolbar layout="panel" panelSection="workspace" {...branchToolbarProps} />

          {props.showOpenInPicker ? (
            <OpenInPicker
              environmentId={props.environmentId}
              keybindings={props.keybindings}
              availableEditors={props.availableEditors}
              openInCwd={props.gitCwd}
              displayMode="panel"
            />
          ) : null}

          {props.activeProjectScripts ? (
            <ProjectScriptsControl
              displayMode="panel"
              scripts={props.activeProjectScripts}
              keybindings={props.keybindings}
              preferredScriptId={props.preferredScriptId}
              onRunScript={props.onRunProjectScript}
              onAddScript={props.onAddProjectScript}
              onUpdateScript={props.onUpdateProjectScript}
              onDeleteScript={props.onDeleteProjectScript}
            />
          ) : null}
        </div>
      </section>

      {props.gitCwd ? (
        <section
          aria-labelledby="thread-details-version-control-heading"
          className="border-t border-border/65"
        >
          <div className="px-3.5 pb-1 pt-3">
            <h3
              id="thread-details-version-control-heading"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Version Control
            </h3>
          </div>
          <div className="flex flex-col px-2 pb-2.5">
            {props.isGitRepo ? (
              <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
            ) : null}
            {props.activeProjectName ? (
              <GitActionsControl
                displayMode="panel"
                gitCwd={props.gitCwd}
                activeThreadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
                {...(props.draftId ? { draftId: props.draftId } : {})}
                {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {!props.draftId ? (
        <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}

      {!props.draftId ? (
        <ThreadRelationshipsPanel environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}
    </div>
  );

  if (props.mode === "popover") {
    return (
      <div className="max-h-[calc(100dvh-6.5rem)]" data-thread-details-panel="popover">
        {card}
      </div>
    );
  }

  return (
    <aside
      aria-label="Thread details"
      className="absolute inset-y-0 right-[var(--app-scrollbar-width)] z-20 w-[var(--thread-details-panel-width)] p-3"
      data-thread-details-panel="inline"
    >
      {card}
    </aside>
  );
}
