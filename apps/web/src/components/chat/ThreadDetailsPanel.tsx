import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, XIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

interface VersionMismatchIssue {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverLabel: string;
}

export interface ThreadDetailsPanelProps {
  forceNewWorktree?: boolean;
  mode: "inline" | "popover";
  onClose?: () => void;
  environmentId: EnvironmentId;
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
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
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
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  const card = (
    <div
      className={cn(
        // A single-track grid, because a grid area is a definite containing block: the card's own
        // height is "content, clamped by max-height", which percentages treat as indefinite — as
        // a plain block (or even a flex column) every `h-full`/`max-h-full` down the chain
        // resolved to nothing, the scroll area's viewport stayed at its content height, and the
        // card's overflow-hidden clipped the content instead of scrolling it. `minmax(0,1fr)`
        // still shrink-wraps short content while letting the clamp bite on tall content.
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[20px]",
        // The popup's real ceiling is what base-ui measured for it — the anchor's clipping
        // ancestors, which is how an open terminal drawer shrinks it — less the popover
        // viewport's own p-2. The dvh term is the fallback's fallback, from before.
        props.mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <ThreadDetailsSection
          headingId="thread-details-workspace-heading"
          title="Workspace"
          separated={false}
        >
          {props.versionMismatch ? (
            <div className="mx-1 mb-2 flex gap-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
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

          <div className="flex flex-col">
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
                fileScripts={fileScripts}
                keybindings={props.keybindings}
                preferredScriptId={props.preferredScriptId}
                onRunScript={props.onRunProjectScript}
                onAddScript={props.onAddProjectScript}
                onUpdateScript={props.onUpdateProjectScript}
                onDeleteScript={props.onDeleteProjectScript}
              />
            ) : null}
          </div>
        </ThreadDetailsSection>

        {props.gitCwd ? (
          <ThreadDetailsSection
            headingId="thread-details-version-control-heading"
            title="Version Control"
          >
            <div className="flex flex-col">
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
          </ThreadDetailsSection>
        ) : null}

        {!props.draftId ? (
          <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}

        {!props.draftId ? (
          <ThreadRelationshipsPanel environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}
      </ScrollArea>
    </div>
  );

  if (props.mode === "popover") {
    return <div data-thread-details-panel="popover">{card}</div>;
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
