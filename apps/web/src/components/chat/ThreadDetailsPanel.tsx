import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadDetailsSectionsSetting,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_THREAD_DETAILS_SECTIONS } from "@t3tools/contracts";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
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
import { ThreadDetailsCustomize } from "./ThreadDetailsCustomize";
import {
  THREAD_DETAILS_SECTION_BY_ID,
  THREAD_DETAILS_SECTION_IDS,
  resolveThreadDetailsSectionRender,
  threadDetailsItemVisible,
  threadDetailsSectionMode,
} from "./threadDetailsCustomization";

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
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
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
  /** Set by a command to open the customize editor; the panel consumes it on mount or change. */
  customizeRequested?: boolean;
  onCustomizeRequestHandled?: () => void;
}

function SectionEmptyState(props: { readonly label: string }) {
  return <p className="px-3.5 py-1 text-[11px] text-muted-foreground">{props.label}</p>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const savedSections = useClientSettings((settings) => settings.threadDetailsSections);
  const updateClientSettings = useUpdateClientSettings();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftSections, setDraftSections] = useState<ThreadDetailsSectionsSetting | null>(null);

  const effectiveSections = customizeOpen && draftSections !== null ? draftSections : savedSections;

  const openCustomize = useCallback(() => {
    setDraftSections(savedSections);
    setCustomizeOpen(true);
  }, [savedSections]);
  const closeCustomize = useCallback(() => {
    setCustomizeOpen(false);
    setDraftSections(null);
  }, []);

  const { customizeRequested, onCustomizeRequestHandled } = props;
  useEffect(() => {
    if (!customizeRequested) return;
    openCustomize();
    onCustomizeRequestHandled?.();
  }, [customizeRequested, onCustomizeRequestHandled, openCustomize]);

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

  const workspaceItems = {
    environment: threadDetailsItemVisible(effectiveSections, "workspace", "environment"),
    branch: threadDetailsItemVisible(effectiveSections, "workspace", "branch"),
    openIn: threadDetailsItemVisible(effectiveSections, "workspace", "openIn"),
    scripts: threadDetailsItemVisible(effectiveSections, "workspace", "scripts"),
  };
  const versionControlItems = {
    branch: threadDetailsItemVisible(effectiveSections, "version-control", "branch"),
    gitActions: threadDetailsItemVisible(effectiveSections, "version-control", "gitActions"),
  };

  const workspaceHasContent =
    (props.availableEnvironments.length > 1 && workspaceItems.environment) ||
    workspaceItems.branch ||
    (props.showOpenInPicker && workspaceItems.openIn) ||
    (props.activeProjectScripts !== undefined && workspaceItems.scripts);
  const workspaceRender = resolveThreadDetailsSectionRender({
    mode: threadDetailsSectionMode(effectiveSections, "workspace"),
    available: true,
    hasContent: workspaceHasContent,
  });

  const versionControlAvailable = props.gitCwd !== null;
  const versionControlHasContent =
    (props.isGitRepo && versionControlItems.branch) ||
    (props.activeProjectName !== undefined && versionControlItems.gitActions);
  const versionControlRender = resolveThreadDetailsSectionRender({
    mode: threadDetailsSectionMode(effectiveSections, "version-control"),
    available: versionControlAvailable,
    hasContent: versionControlHasContent,
  });

  const automationsMode = threadDetailsSectionMode(effectiveSections, "automations");
  const automationsAvailable = !props.draftId;
  const relationshipsMode = threadDetailsSectionMode(effectiveSections, "relationships");
  const relationshipsAvailable = !props.draftId;

  const versionMismatchBanner = props.versionMismatch ? (
    <div className="px-3 pt-3">
      <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
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
    </div>
  ) : null;

  const workspaceSection = (() => {
    if (!workspaceRender.render) return null;
    const definition = THREAD_DETAILS_SECTION_BY_ID.workspace;
    return (
      <ThreadDetailsSection
        headingId="thread-details-workspace-heading"
        title="Workspace"
        separated={false}
      >
        {workspaceRender.showEmptyState ? (
          <SectionEmptyState label={definition.emptyLabel} />
        ) : (
          <div className="flex flex-col">
            {props.availableEnvironments.length > 1 && workspaceItems.environment ? (
              <BranchToolbarEnvironmentSelector
                displayMode="panel"
                autoEnvironmentLabel={props.autoEnvironmentLabel}
                onAutoEnvironment={props.onAutoEnvironment}
                envLocked={props.envLocked}
                environmentId={props.environmentId}
                availableEnvironments={props.availableEnvironments}
                onEnvironmentChange={props.onEnvironmentChange}
              />
            ) : null}

            {workspaceItems.branch ? (
              <BranchToolbar layout="panel" panelSection="workspace" {...branchToolbarProps} />
            ) : null}

            {props.showOpenInPicker && workspaceItems.openIn ? (
              <OpenInPicker
                environmentId={props.environmentId}
                keybindings={props.keybindings}
                availableEditors={props.availableEditors}
                openInCwd={props.gitCwd}
                displayMode="panel"
              />
            ) : null}

            {props.activeProjectScripts && workspaceItems.scripts ? (
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
        )}
      </ThreadDetailsSection>
    );
  })();

  const versionControlSection = (() => {
    if (!versionControlRender.render) return null;
    const definition = THREAD_DETAILS_SECTION_BY_ID["version-control"];
    return (
      <ThreadDetailsSection
        headingId="thread-details-version-control-heading"
        title="Version Control"
      >
        {versionControlRender.showEmptyState ? (
          <SectionEmptyState label={definition.emptyLabel} />
        ) : (
          <div className="flex flex-col">
            {props.isGitRepo && versionControlItems.branch ? (
              <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
            ) : null}
            {props.activeProjectName && versionControlItems.gitActions ? (
              <GitActionsControl
                displayMode="panel"
                gitCwd={props.gitCwd}
                activeThreadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
                {...(props.draftId ? { draftId: props.draftId } : {})}
                {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
              />
            ) : null}
          </div>
        )}
      </ThreadDetailsSection>
    );
  })();

  const automationsSection =
    automationsMode === "hidden" || !automationsAvailable ? null : (
      <ThreadAutomationsPanel
        environmentId={props.environmentId}
        threadId={props.threadId}
        alwaysVisible={automationsMode === "always"}
      />
    );

  const relationshipsSection =
    relationshipsMode === "hidden" || !relationshipsAvailable ? null : (
      <ThreadRelationshipsPanel
        environmentId={props.environmentId}
        threadId={props.threadId}
        alwaysVisible={relationshipsMode === "always"}
      />
    );

  const card = (
    <div
      className={cn(
        // A single-track grid, because a grid area is a definite containing block: the card's own
        // height is "content, clamped by max-height", which percentages treat as indefinite — as
        // a plain block (or even a flex column) every `h-full`/`max-h-full` down the chain
        // resolved to nothing, the scroll area's viewport stayed at its content height, and the
        // card's overflow-hidden clipped the content instead of scrolling it. `minmax(0,1fr)`
        // still shrink-wraps short content while letting the clamp bite on tall content.
        "dropdown-glass isolate contain-paint group/thread-details relative grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[20px]",
        // The popup's real ceiling is what base-ui measured for it — the anchor's clipping
        // ancestors, which is how an open terminal drawer shrinks it — less the popover
        // viewport's own p-2. The dvh term is the fallback's fallback, from before.
        props.mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      data-thread-details-card
    >
      <ThreadDetailsCustomize
        availableForDraft={
          props.draftId ? (["workspace", "version-control"] as const) : THREAD_DETAILS_SECTION_IDS
        }
        open={customizeOpen}
        sections={draftSections ?? savedSections}
        onCancel={closeCustomize}
        onChange={setDraftSections}
        onDone={() => {
          // The settings store applies the patch optimistically, so closing
          // now cannot flash the old arrangement or race a reopened editor.
          void updateClientSettings({
            threadDetailsSections: draftSections ?? DEFAULT_THREAD_DETAILS_SECTIONS,
          });
          closeCustomize();
        }}
        onOpenChange={(open) => {
          if (open) {
            openCustomize();
          } else {
            // Escape and outside clicks discard, matching Cancel, so an
            // accidental dismissal never persists a half-finished arrangement.
            closeCustomize();
          }
        }}
        onReset={() => setDraftSections(DEFAULT_THREAD_DETAILS_SECTIONS)}
      />
      <ScrollArea scrollFade className="min-h-0">
        {versionMismatchBanner}
        {workspaceSection}
        {versionControlSection}
        {automationsSection}
        {relationshipsSection}
        {/* Automations and Lineage decide their own emptiness from live data,
            so the fallback hides itself in CSS once any section renders. */}
        {!workspaceRender.render && !versionControlRender.render && !customizeOpen ? (
          <div className="flex flex-col items-start gap-2 px-3 py-3 group-has-[section]/thread-details:hidden">
            <p className="text-[13px] text-muted-foreground">No details to show.</p>
            <Button size="xs" variant="outline" onClick={openCustomize}>
              Customize
            </Button>
          </div>
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
