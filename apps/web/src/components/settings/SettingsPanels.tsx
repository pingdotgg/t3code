import {
  ArchiveIcon,
  ArchiveX,
  CircleAlertIcon,
  FolderOpenIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE,
  DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
  DEFAULT_REVIEW_CHANGES_SCOPE,
  type AgentWorkflowDestinationMode,
  DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS,
  DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD,
  DEFAULT_PROVIDER_DRIVER_KIND,
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  type EnvironmentId,
  type ModelSelection,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  resolveBrowserProfiles,
  type BrowserProfile,
  type BrowserImportSource,
  type BrowserImportSourceId,
  BROWSER_IMPORT_FAILURE_COPY,
  BROWSER_IMPORT_UNAVAILABLE_COPY,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type PullRequestListState,
  type ReviewChangesScope,
  type CollaborativeAcceptancePolicy,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import {
  DEFAULT_CHAT_FONT_SIZE,
  RECOMMENDED_FONT_SIZES_BY_UI_DENSITY,
  DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INPUT_FONT_SIZE,
  DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS,
  DEFAULT_SIDEBAR_FONT_SIZE,
  DEFAULT_SIDEBAR_META_FONT_SIZE,
  DEFAULT_SIDEBAR_ROW_SPACING,
  DEFAULT_SIDEBAR_TRANSLUCENCY,
  DEFAULT_SIDEBAR_V2_ENABLED,
  DEFAULT_STATUS_LINE_FONT_SIZE,
  DEFAULT_TOOL_FONT_SIZE,
  DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE,
  DEFAULT_UI_DENSITY,
  DEFAULT_UI_FONT,
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_HEADER_SHOW_PROJECT_SCRIPTS,
  DEFAULT_HEADER_SHOW_OPEN_IN,
  DEFAULT_HEADER_SHOW_GIT_ACTIONS,
  DEFAULT_HEADER_SHOW_WORKFLOWS,
  DEFAULT_HEADER_SHOW_WORKFLOW_RUNS,
  DEFAULT_HEADER_SHOW_EXPORT_CHAT,
  DEFAULT_HEADER_SHOW_INSIGHTS_TOGGLE,
  DEFAULT_HEADER_SHOW_BROWSER_TOGGLE,
  DEFAULT_HEADER_SHOW_FILES_TOGGLE,
  DEFAULT_HEADER_SHOW_TERMINAL_TOGGLE,
  DEFAULT_HEADER_SHOW_DIFF_TOGGLE,
  DEFAULT_SIDEBAR_SHOW_SEARCH,
  DEFAULT_SIDEBAR_SHOW_PULL_REQUESTS,
  DEFAULT_SIDEBAR_SHOW_SKILLS,
  DEFAULT_SIDEBAR_SHOW_NEW_THREAD,
  DEFAULT_HEADER_EXPORT_CONFIRM,
  DEFAULT_PROJECT_SCRIPTS_CONFIRM_RUN,
  DEFAULT_OPEN_IN_UPDATE_PREFERRED,
  DEFAULT_GIT_CONFIRM_DEFAULT_BRANCH,
  DEFAULT_GIT_SHOW_QUICK_ACTION,
  DEFAULT_WORKFLOW_CONFIRM_RUN,
  DEFAULT_WORKFLOW_PREWARM_ON_HOVER,
  DEFAULT_WORKFLOW_RUNS_SHOW_BADGE,
  DEFAULT_SIDEBAR_SEARCH_SHOW_SHORTCUT,
  DEFAULT_SIDEBAR_NEW_THREAD_CONFIRM,
  DEFAULT_LOCAL_REBUILD_STALENESS_CHECK_MINUTES,
  MAX_LOCAL_REBUILD_STALENESS_CHECK_MINUTES,
  type CodeFont,
  type FontSize,
  type MessagePreviewLineCount,
  type SidebarRowSpacing,
  type SidebarTranslucency,
  type ThreadCompletionNotificationMode,
  type UiDensity,
  type UiFont,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import { useArchivedThreadSnapshots } from "../../archivedThreadsState";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { DeviceSettings } from "./DeviceSettings";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useLocalRebuildState, useRequestLocalRebuild } from "../../hooks/useLocalRebuild";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  resolveDelegatedThreadModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";
import {
  buildArchivedThreadGroupsFromSnapshots,
  buildProviderInstanceUpdatePatch,
  filterArchivedThreadGroups,
  mergeCollaborativeAcceptancePolicy,
  runSequentiallySettled,
  type CollaborativeAcceptancePolicyPatch,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import { reportClientWarning } from "../../lib/clientLogger";
import {
  useServerAvailableEditors,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const UI_DENSITY_OPTIONS: ReadonlyArray<{ value: UiDensity; label: string; hint: string }> = [
  { value: "compact", label: "Compact", hint: "— tighter spacing" },
  { value: "default", label: "Default", hint: "— balanced" },
  { value: "comfortable", label: "Comfortable", hint: "— relaxed spacing" },
  { value: "spacious", label: "Spacious", hint: "— more breathing room" },
];

const SIDEBAR_ROW_SPACING_OPTIONS: ReadonlyArray<{
  value: SidebarRowSpacing;
  label: string;
  hint: string;
}> = [
  { value: "compact", label: "Compact", hint: "— more threads on screen" },
  { value: "default", label: "Default", hint: "— balanced" },
  { value: "relaxed", label: "Relaxed", hint: "— more breathing room" },
];

const SIDEBAR_TRANSLUCENCY_OPTIONS: ReadonlyArray<{
  value: SidebarTranslucency;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "Off", hint: "— opaque, fastest" },
  { value: "subtle", label: "Subtle", hint: "— light frosted tint" },
  { value: "medium", label: "Medium", hint: "— balanced translucency" },
  { value: "strong", label: "Strong", hint: "— most see-through" },
  { value: "liquid-glass", label: "Liquid Glass", hint: "— ultra-clear, highest blur" },
];

const THREAD_COMPLETION_NOTIFICATION_OPTIONS: ReadonlyArray<{
  value: ThreadCompletionNotificationMode;
  label: string;
}> = [
  { value: "background-only", label: "Background only" },
  { value: "all", label: "All completions" },
  { value: "off", label: "Off" },
];

const REVIEW_CHANGES_SCOPE_OPTIONS: ReadonlyArray<{
  value: ReviewChangesScope;
  label: string;
}> = [
  { value: "uncommitted", label: "Uncommitted changes" },
  { value: "against-base", label: "Against base branch" },
];

const WORKFLOW_DESTINATION_OPTIONS: ReadonlyArray<{
  value: AgentWorkflowDestinationMode;
  label: string;
}> = [
  { value: "same-chat", label: "Same chat" },
  { value: "new-chat", label: "New chat" },
  { value: "child-chat", label: "Child chat" },
];

const COLLABORATIVE_ACCEPTANCE_AUTOMATION_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "bounded", label: "Bounded" },
  { value: "until-ready", label: "Continue until ready" },
] as const;

const COLLABORATIVE_ACCEPTANCE_TRIGGER_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "first-candidate", label: "First eligible candidate" },
  { value: "each-eligible-candidate", label: "Every eligible candidate" },
] as const;

const COLLABORATIVE_ACCEPTANCE_COMMENT_OPTIONS = [
  { value: "blocking-only", label: "Blocking only" },
  { value: "all-actionable-addressed", label: "All actionable feedback" },
  { value: "all-review-threads-resolved", label: "All review threads resolved" },
] as const;

type HeaderSidebarToggleKey = keyof Pick<
  UnifiedSettings,
  | "headerShowProjectScripts"
  | "headerShowOpenIn"
  | "headerShowGitActions"
  | "headerShowWorkflows"
  | "headerShowWorkflowRuns"
  | "headerShowExportChat"
  | "headerShowInsightsToggle"
  | "headerShowBrowserToggle"
  | "headerShowFilesToggle"
  | "headerShowTerminalToggle"
  | "headerShowDiffToggle"
  | "sidebarShowSearch"
  | "sidebarShowPullRequests"
  | "sidebarShowSkills"
  | "sidebarShowNewThread"
  | "headerExportConfirm"
  | "projectScriptsConfirmRun"
  | "openInUpdatePreferred"
  | "gitConfirmDefaultBranch"
  | "gitShowQuickAction"
  | "workflowConfirmRun"
  | "workflowPrewarmOnHover"
  | "workflowRunsShowBadge"
  | "sidebarSearchShowShortcut"
  | "sidebarNewThreadConfirm"
>;

const HEADER_VISIBILITY_ROWS: ReadonlyArray<{
  key: HeaderSidebarToggleKey;
  title: string;
  description: string;
}> = [
  {
    key: "headerShowProjectScripts",
    title: "Project scripts",
    description: "Show project action runner in the chat header.",
  },
  {
    key: "headerShowOpenIn",
    title: "Open in editor",
    description: "Show the open-in-editor picker in the chat header.",
  },
  {
    key: "headerShowGitActions",
    title: "Git actions",
    description: "Show commit, push, and PR actions in the chat header.",
  },
  {
    key: "headerShowWorkflows",
    title: "Workflows",
    description: "Show agent workflow buttons in the chat header.",
  },
  {
    key: "headerShowWorkflowRuns",
    title: "Workflow runs",
    description: "Show the workflow runs popover in the chat header.",
  },
  {
    key: "headerShowExportChat",
    title: "Export chat",
    description: "Show the export-chat button in the chat header.",
  },
];

const PANEL_TOGGLE_ROWS: ReadonlyArray<{
  key: HeaderSidebarToggleKey;
  title: string;
  description: string;
}> = [
  {
    key: "headerShowInsightsToggle",
    title: "Insights toggle",
    description: "Show the insights panel toggle.",
  },
  {
    key: "headerShowBrowserToggle",
    title: "Browser toggle",
    description: "Show the browser preview toggle.",
  },
  {
    key: "headerShowFilesToggle",
    title: "Files toggle",
    description: "Show the file browser toggle.",
  },
  {
    key: "headerShowTerminalToggle",
    title: "Terminal toggle",
    description: "Show the terminal drawer toggle.",
  },
  { key: "headerShowDiffToggle", title: "Diff toggle", description: "Show the diff panel toggle." },
];

const SIDEBAR_VISIBILITY_ROWS: ReadonlyArray<{
  key: HeaderSidebarToggleKey;
  title: string;
  description: string;
}> = [
  {
    key: "sidebarShowSearch",
    title: "Search",
    description: "Show Search in the sidebar top actions.",
  },
  {
    key: "sidebarShowPullRequests",
    title: "Pull requests",
    description: "Show Pull Requests in the sidebar footer.",
  },
  {
    key: "sidebarShowSkills",
    title: "Skills",
    description: "Show Skills in the sidebar footer.",
  },
  {
    key: "sidebarShowNewThread",
    title: "New thread",
    description: "Show New thread in the sidebar top actions.",
  },
];

const HEADER_BEHAVIOR_ROWS: ReadonlyArray<{
  key: HeaderSidebarToggleKey;
  title: string;
  description: string;
}> = [
  {
    key: "headerExportConfirm",
    title: "Confirm before export",
    description: "Ask for confirmation before exporting a chat.",
  },
  {
    key: "projectScriptsConfirmRun",
    title: "Confirm script runs",
    description: "Ask for confirmation before running a project script.",
  },
  {
    key: "openInUpdatePreferred",
    title: "Remember preferred editor",
    description: "Update the preferred editor when picking from the Open-in menu.",
  },
  {
    key: "gitConfirmDefaultBranch",
    title: "Confirm default-branch git actions",
    description: "Show the default-branch confirmation for push and PR actions.",
  },
  {
    key: "gitShowQuickAction",
    title: "Git quick action",
    description: "Show the one-click git quick action beside the git menu.",
  },
  {
    key: "workflowConfirmRun",
    title: "Confirm workflow runs",
    description: "Ask for confirmation before running a header workflow.",
  },
  {
    key: "workflowPrewarmOnHover",
    title: "Prewarm workflows on hover",
    description: "Prewarm provider sessions and PR data when hovering workflow buttons.",
  },
  {
    key: "workflowRunsShowBadge",
    title: "Workflow badge count",
    description: "Show the running-workflow count badge on the runs button.",
  },
  {
    key: "sidebarSearchShowShortcut",
    title: "Search shortcut hint",
    description: "Include the keyboard shortcut in the Search tooltip.",
  },
  {
    key: "sidebarNewThreadConfirm",
    title: "Confirm new thread",
    description: "Ask for confirmation before creating a thread from the sidebar.",
  },
];

const HEADER_SIDEBAR_DEFAULTS: Record<HeaderSidebarToggleKey, boolean> = {
  headerShowProjectScripts: DEFAULT_HEADER_SHOW_PROJECT_SCRIPTS,
  headerShowOpenIn: DEFAULT_HEADER_SHOW_OPEN_IN,
  headerShowGitActions: DEFAULT_HEADER_SHOW_GIT_ACTIONS,
  headerShowWorkflows: DEFAULT_HEADER_SHOW_WORKFLOWS,
  headerShowWorkflowRuns: DEFAULT_HEADER_SHOW_WORKFLOW_RUNS,
  headerShowExportChat: DEFAULT_HEADER_SHOW_EXPORT_CHAT,
  headerShowInsightsToggle: DEFAULT_HEADER_SHOW_INSIGHTS_TOGGLE,
  headerShowBrowserToggle: DEFAULT_HEADER_SHOW_BROWSER_TOGGLE,
  headerShowFilesToggle: DEFAULT_HEADER_SHOW_FILES_TOGGLE,
  headerShowTerminalToggle: DEFAULT_HEADER_SHOW_TERMINAL_TOGGLE,
  headerShowDiffToggle: DEFAULT_HEADER_SHOW_DIFF_TOGGLE,
  sidebarShowSearch: DEFAULT_SIDEBAR_SHOW_SEARCH,
  sidebarShowPullRequests: DEFAULT_SIDEBAR_SHOW_PULL_REQUESTS,
  sidebarShowSkills: DEFAULT_SIDEBAR_SHOW_SKILLS,
  sidebarShowNewThread: DEFAULT_SIDEBAR_SHOW_NEW_THREAD,
  headerExportConfirm: DEFAULT_HEADER_EXPORT_CONFIRM,
  projectScriptsConfirmRun: DEFAULT_PROJECT_SCRIPTS_CONFIRM_RUN,
  openInUpdatePreferred: DEFAULT_OPEN_IN_UPDATE_PREFERRED,
  gitConfirmDefaultBranch: DEFAULT_GIT_CONFIRM_DEFAULT_BRANCH,
  gitShowQuickAction: DEFAULT_GIT_SHOW_QUICK_ACTION,
  workflowConfirmRun: DEFAULT_WORKFLOW_CONFIRM_RUN,
  workflowPrewarmOnHover: DEFAULT_WORKFLOW_PREWARM_ON_HOVER,
  workflowRunsShowBadge: DEFAULT_WORKFLOW_RUNS_SHOW_BADGE,
  sidebarSearchShowShortcut: DEFAULT_SIDEBAR_SEARCH_SHOW_SHORTCUT,
  sidebarNewThreadConfirm: DEFAULT_SIDEBAR_NEW_THREAD_CONFIRM,
};

const DEFAULT_DRIVER_KIND = DEFAULT_PROVIDER_DRIVER_KIND;

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function WorkflowModelControls({
  modelSelection,
  onModelSelectionChange,
}: {
  readonly modelSelection: ModelSelection | null | undefined;
  readonly onModelSelectionChange: (modelSelection: ModelSelection | null) => void;
}) {
  const settings = useSettings();
  const serverProviders = useServerProviders();
  const instanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
    [serverProviders],
  );
  const selectedInstanceId = modelSelection?.instanceId ?? instanceEntries[0]?.instanceId;
  const selectedInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === selectedInstanceId,
  );
  const selectedModel = modelSelection?.model ?? selectedInstanceEntry?.models[0]?.slug ?? "";
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, serverProviders, selectedInstanceId, selectedModel),
    [selectedInstanceId, selectedModel, serverProviders, settings],
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:col-span-2">
      <div>
        <div className="text-xs text-muted-foreground">Model and reasoning</div>
        <div className="mt-0.5 text-xs text-muted-foreground/80">
          {modelSelection
            ? "Use this model and reasoning level whenever the workflow runs."
            : "Inherit the model and reasoning level from the chat that starts the workflow."}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {modelSelection && selectedInstanceId && selectedInstanceEntry ? (
          <>
            <ProviderModelPicker
              activeInstanceId={selectedInstanceId}
              model={selectedModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onInstanceModelChange={(instanceId, model) =>
                onModelSelectionChange(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={selectedInstanceEntry.driverKind}
              instanceId={selectedInstanceId}
              models={selectedInstanceEntry.models}
              model={selectedModel}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={modelSelection.options}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              onModelOptionsChange={(options) =>
                onModelSelectionChange(
                  createModelSelection(selectedInstanceId, selectedModel, options),
                )
              }
            />
          </>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={!modelSelection && (!selectedInstanceId || !selectedModel)}
          onClick={() =>
            onModelSelectionChange(
              modelSelection ? null : createModelSelection(selectedInstanceId!, selectedModel),
            )
          }
        >
          {modelSelection ? "Inherit chat model" : "Choose model"}
        </Button>
      </div>
    </div>
  );
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const UI_FONT_OPTIONS: ReadonlyArray<{ value: UiFont; label: string }> = [
  {
    value: "dm-sans",
    label: "DM Sans",
  },
  {
    value: "geist",
    label: "Geist",
  },
  {
    value: "system-ui",
    label: "San Francisco",
  },
];

function isUiFont(value: unknown): value is UiFont {
  return UI_FONT_OPTIONS.some((option) => option.value === value);
}

const CODE_FONT_OPTIONS: ReadonlyArray<{ value: CodeFont; label: string }> = [
  {
    value: "system-mono",
    label: "System mono",
  },
  {
    value: "sf-mono",
    label: "SF Mono",
  },
  {
    value: "menlo",
    label: "Menlo",
  },
  {
    value: "jetbrains-mono",
    label: "JetBrains Mono",
  },
];

function isCodeFont(value: unknown): value is CodeFont {
  return CODE_FONT_OPTIONS.some((option) => option.value === value);
}

const FONT_SIZE_OPTIONS: ReadonlyArray<{ value: FontSize; label: string }> = [
  { value: 6, label: "6px" },
  { value: 7, label: "7px" },
  { value: 8, label: "8px" },
  { value: 9, label: "9px" },
  { value: 10, label: "10px" },
  { value: 11, label: "11px" },
  { value: 12, label: "12px" },
  { value: 13, label: "13px" },
  { value: 14, label: "14px" },
  { value: 15, label: "15px" },
  { value: 16, label: "16px" },
  { value: 18, label: "18px" },
  { value: 20, label: "20px" },
  { value: 22, label: "22px" },
  { value: 24, label: "24px" },
];

const MESSAGE_PREVIEW_LINE_OPTIONS: ReadonlyArray<MessagePreviewLineCount> = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30,
];

function isMessagePreviewLineCount(value: unknown): value is MessagePreviewLineCount {
  return MESSAGE_PREVIEW_LINE_OPTIONS.some((option) => String(option) === String(value));
}

function formatMessagePreviewLineCount(lineCount: MessagePreviewLineCount): string {
  return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

function isFontSize(value: unknown): value is FontSize {
  return FONT_SIZE_OPTIONS.some((option) => String(option.value) === String(value));
}

const PULL_REQUESTS_STATE_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestListState;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "all", label: "All states" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];

function isPullRequestListState(value: unknown): value is PullRequestListState {
  return PULL_REQUESTS_STATE_OPTIONS.some((option) => option.value === value);
}

function isReviewChangesScope(value: unknown): value is ReviewChangesScope {
  return REVIEW_CHANGES_SCOPE_OPTIONS.some((option) => option.value === value);
}

function isAgentWorkflowDestinationMode(value: unknown): value is AgentWorkflowDestinationMode {
  return WORKFLOW_DESTINATION_OPTIONS.some((option) => option.value === value);
}

function WorkflowPromptTemplateEditor({
  value,
  onCommit,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (nextValue: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commitDraft = useCallback(() => {
    if (draft !== value) {
      onCommit(draft);
    }
  }, [draft, onCommit, value]);

  return (
    <Textarea
      className="mt-4 w-full"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      rows={9}
    />
  );
}

type InstallProviderSettings = {
  provider: ProviderDriverKind;
  title: string;
  badgeLabel?: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  serverUrlPlaceholder?: string;
  serverUrlDescription?: ReactNode;
  serverPasswordPlaceholder?: string;
  serverPasswordDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: ProviderDriverKind.make("codex"),
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: ProviderDriverKind.make("claudeAgent"),
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: ProviderDriverKind.make("cursor"),
    title: "Cursor",
    badgeLabel: "Early Access",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary",
  },
  {
    provider: ProviderDriverKind.make("copilot"),
    title: "GitHub Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the GitHub Copilot CLI binary",
  },
  {
    provider: ProviderDriverKind.make("opencode"),
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
    serverUrlPlaceholder: "http://127.0.0.1:4096",
    serverUrlDescription: "Leave blank to let T3 Code spawn the server when needed",
    serverPasswordPlaceholder: "Server password (optional)",
    serverPasswordDescription:
      "If your OpenCode server requires authentication, enter the password here. NOTE: Stored in plain text on disk",
  },
] as const;

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const localRebuildState = useLocalRebuildState();
  const { requestLocalRebuild, isStartingLocalRebuild } = useRequestLocalRebuild();
  const checkMinutes = useSettings((settings) => settings.localRebuildStalenessCheckMinutes);
  const { updateSettings } = useUpdateSettings();

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {localRebuildState?.enabled ? (
        <SettingsRow
          title="Local source"
          description="Build and install the current checkout, then restart T3 Code."
          status={
            <span className="block break-all font-mono text-[11px] text-foreground">
              {localRebuildState.sourceRoot}
            </span>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isStartingLocalRebuild}
              onClick={requestLocalRebuild}
            >
              <RefreshCwIcon className={isStartingLocalRebuild ? "animate-spin" : undefined} />
              {isStartingLocalRebuild ? "Starting..." : "Rebuild and restart"}
            </Button>
          }
        />
      ) : null}
      {localRebuildState?.enabled ? (
        <SettingsRow
          title="Check for source updates"
          description="Check whether the remote default branch moved past the running build. The sidebar refresh icon lights up when a rebuild would bring in newer changes. Set 0 to turn the check off."
          resetAction={
            checkMinutes !== DEFAULT_LOCAL_REBUILD_STALENESS_CHECK_MINUTES ? (
              <SettingResetButton
                label="source update check interval"
                onClick={() =>
                  updateSettings({
                    localRebuildStalenessCheckMinutes:
                      DEFAULT_LOCAL_REBUILD_STALENESS_CHECK_MINUTES,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-24"
              value={String(checkMinutes)}
              inputMode="numeric"
              onCommit={(value) => {
                const minutes = Number.parseInt(value.trim(), 10);
                if (
                  !Number.isFinite(minutes) ||
                  minutes < 0 ||
                  minutes > MAX_LOCAL_REBUILD_STALENESS_CHECK_MINUTES
                ) {
                  toastManager.add({
                    type: "warning",
                    title: `Check interval must be between 0 and ${MAX_LOCAL_REBUILD_STALENESS_CHECK_MINUTES} minutes`,
                  });
                  return;
                }
                updateSettings({ localRebuildStalenessCheckMinutes: minutes });
              }}
              aria-label="Source update check interval in minutes"
            />
          }
        />
      ) : null}
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
            >
              <SelectValue>
                {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isDelegatedThreadModelDirty = !Equal.equals(
    settings.delegatedThreadModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.delegatedThreadModelSelection ?? null,
  );
  // A provider surface is "dirty" if either the legacy per-kind
  // `settings.providers[kind]` struct differs from defaults (for users
  // on pre-migration data) or the new `settings.providerInstances` map
  // has any entries (every edit to a default slot promotes it into an
  // explicit entry, so any key in that map represents user intent to
  // diverge from factory defaults). Checking both keeps the Restore
  // Defaults chip accurate throughout the legacy→instance migration.
  const areProviderSettingsDirty =
    PROVIDER_SETTINGS.some((providerSettings) => {
      type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
      const currentProviders = settings.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const defaultProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const currentSettings = currentProviders[providerSettings.provider];
      const defaultSettings = defaultProviders[providerSettings.provider];
      return !Equal.equals(currentSettings, defaultSettings);
    }) ||
    Object.keys(settings.providerInstances ?? {}).length > 0 ||
    Object.keys(settings.providerModelPreferences ?? {}).length > 0 ||
    (settings.favorites ?? []).length > 0;

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.uiDensity !== DEFAULT_UNIFIED_SETTINGS.uiDensity ? ["UI density"] : []),
      ...(settings.sidebarTranslucency !== DEFAULT_UNIFIED_SETTINGS.sidebarTranslucency
        ? ["Sidebar translucency"]
        : []),
      ...(settings.uiFont !== DEFAULT_UNIFIED_SETTINGS.uiFont ? ["Interface font"] : []),
      ...(settings.codeFont !== DEFAULT_UNIFIED_SETTINGS.codeFont ? ["Code font"] : []),
      ...(settings.codeFontSize !== DEFAULT_UNIFIED_SETTINGS.codeFontSize
        ? ["Code font size"]
        : []),
      ...(settings.chatFontSize !== DEFAULT_UNIFIED_SETTINGS.chatFontSize
        ? ["Chat font size"]
        : []),
      ...(!Equal.equals(
        settings.messagePreviewLineLimits,
        DEFAULT_UNIFIED_SETTINGS.messagePreviewLineLimits,
      )
        ? ["Message preview lines"]
        : []),
      ...(settings.statusLineFontSize !== DEFAULT_UNIFIED_SETTINGS.statusLineFontSize
        ? ["Status line font size"]
        : []),
      ...(settings.inputFontSize !== DEFAULT_UNIFIED_SETTINGS.inputFontSize
        ? ["Input font size"]
        : []),
      ...(settings.sidebarFontSize !== DEFAULT_UNIFIED_SETTINGS.sidebarFontSize
        ? ["Sidebar font size"]
        : []),
      ...(settings.sidebarMetaFontSize !== DEFAULT_UNIFIED_SETTINGS.sidebarMetaFontSize
        ? ["Sidebar metadata font size"]
        : []),
      ...(settings.sidebarRowSpacing !== DEFAULT_UNIFIED_SETTINGS.sidebarRowSpacing
        ? ["Sidebar row spacing"]
        : []),
      ...(settings.toolFontSize !== DEFAULT_UNIFIED_SETTINGS.toolFontSize
        ? ["Tool font size"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.pullRequestsDefaultState !== DEFAULT_UNIFIED_SETTINGS.pullRequestsDefaultState
        ? ["Pull requests default state"]
        : []),
      ...(settings.pullRequestsCodeFontSize !== DEFAULT_UNIFIED_SETTINGS.pullRequestsCodeFontSize
        ? ["Pull requests code font size"]
        : []),
      ...(settings.browserAutoShowFloatingPreview !==
      DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
        ? ["Agent browser preview"]
        : []),
      ...(settings.browserRecordingFrameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE
        ? ["Browser recording frame rate"]
        : []),
      ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
        ? ["Agent browser access"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.threadCompletionNotifications !==
      DEFAULT_UNIFIED_SETTINGS.threadCompletionNotifications
        ? ["Completion notifications"]
        : []),
      ...(!Equal.equals(settings.agentWorkflows, DEFAULT_UNIFIED_SETTINGS.agentWorkflows)
        ? ["Agent workflows"]
        : []),
      ...(Object.keys(HEADER_SIDEBAR_DEFAULTS).some(
        (key) =>
          settings[key as HeaderSidebarToggleKey] !==
          HEADER_SIDEBAR_DEFAULTS[key as HeaderSidebarToggleKey],
      )
        ? ["Header & sidebar buttons"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(isDelegatedThreadModelDirty ? ["Delegated thread model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      isDelegatedThreadModelDirty,
      settings.autoOpenPlanSidebar,
      settings.browserAutoShowFloatingPreview,
      settings.browserRecordingFrameRate,
      settings.enableAgentBrowserAccess,
      settings.chatFontSize,
      settings.messagePreviewLineLimits,
      settings.codeFontSize,
      settings.statusLineFontSize,
      settings.inputFontSize,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.codeFont,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.gitConfirmDefaultBranch,
      settings.gitShowQuickAction,
      settings.headerExportConfirm,
      settings.headerShowBrowserToggle,
      settings.headerShowDiffToggle,
      settings.headerShowExportChat,
      settings.headerShowFilesToggle,
      settings.headerShowGitActions,
      settings.headerShowInsightsToggle,
      settings.headerShowOpenIn,
      settings.headerShowProjectScripts,
      settings.headerShowTerminalToggle,
      settings.headerShowWorkflowRuns,
      settings.headerShowWorkflows,
      settings.openInUpdatePreferred,
      settings.projectScriptsConfirmRun,
      settings.pullRequestsDefaultState,
      settings.pullRequestsCodeFontSize,
      settings.enableAssistantStreaming,
      settings.agentWorkflows,
      settings.sidebarFontSize,
      settings.sidebarMetaFontSize,
      settings.sidebarNewThreadConfirm,
      settings.sidebarRowSpacing,
      settings.sidebarSearchShowShortcut,
      settings.sidebarShowNewThread,
      settings.sidebarShowPullRequests,
      settings.sidebarShowSearch,
      settings.sidebarShowSkills,
      settings.sidebarTranslucency,
      settings.threadCompletionNotifications,
      settings.timestampFormat,
      settings.toolFontSize,
      settings.uiDensity,
      settings.uiFont,
      settings.workflowConfirmRun,
      settings.workflowPrewarmOnHover,
      settings.workflowRunsShowBadge,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function HeaderSidebarToggleRows({
  rows,
  settings,
  updateSettings,
}: {
  readonly rows: ReadonlyArray<{
    readonly key: HeaderSidebarToggleKey;
    readonly title: string;
    readonly description: string;
  }>;
  readonly settings: UnifiedSettings;
  readonly updateSettings: (patch: Partial<UnifiedSettings>) => void;
}) {
  return rows.map((row) => (
    <SettingsRow
      key={row.key}
      title={row.title}
      description={row.description}
      resetAction={
        settings[row.key] !== HEADER_SIDEBAR_DEFAULTS[row.key] ? (
          <SettingResetButton
            label={row.title.toLowerCase()}
            onClick={() => updateSettings({ [row.key]: HEADER_SIDEBAR_DEFAULTS[row.key] })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings[row.key]}
          onCheckedChange={(checked) => updateSettings({ [row.key]: Boolean(checked) })}
        />
      }
    />
  ));
}

export function GeneralSettingsPanel() {
  const browserEnvironmentId = usePrimaryEnvironmentId();
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  // Each size's "reset" target follows the active density, so resetting always
  // lands on the value that density was designed around.
  const recommendedFontSizes = RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[settings.uiDensity];
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isPickingChatExportDirectory, setIsPickingChatExportDirectory] = useState(false);
  const [isExportingActiveChats, setIsExportingActiveChats] = useState(false);
  const [isImportingChatArchive, setIsImportingChatArchive] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [newBrowserProfileName, setNewBrowserProfileName] = useState("");
  const [browserProfileNames, setBrowserProfileNames] = useState<Record<string, string>>({});
  const [browserImportSources, setBrowserImportSources] = useState<
    ReadonlyArray<BrowserImportSource>
  >([]);
  const [browserImportSourceId, setBrowserImportSourceId] = useState<BrowserImportSourceId | "">(
    "",
  );
  const [browserImportProfileDirectory, setBrowserImportProfileDirectory] = useState("");
  const [browserImportStatus, setBrowserImportStatus] = useState<string | null>(null);
  const [browserImportConsent, setBrowserImportConsent] = useState(false);
  const [browserImportTargetProfileId, setBrowserImportTargetProfileId] = useState(
    settings.browserDefaultProfileId,
  );
  const browserProfiles = resolveBrowserProfiles(settings.browserProfiles);
  const importTargetProfile =
    browserProfiles.find(
      (profile) => profile.id === browserImportTargetProfileId && profile.kind !== "incognito",
    ) ?? browserProfiles.find((profile) => profile.id === DEFAULT_BROWSER_PROFILE_ID)!;
  useEffect(() => {
    setBrowserImportConsent(false);
  }, [importTargetProfile.id, browserImportSourceId, browserImportProfileDirectory]);
  const updateBrowserProfileName = useCallback(
    (profile: BrowserProfile) => {
      const name = (browserProfileNames[profile.id] ?? profile.name).trim();
      if (!name || name === profile.name) return;
      updateSettings({
        browserProfiles: settings.browserProfiles.map((candidate) =>
          candidate.id === profile.id ? { ...candidate, name } : candidate,
        ),
      });
    },
    [browserProfileNames, settings.browserProfiles, updateSettings],
  );
  const addBrowserProfile = useCallback(() => {
    const name = newBrowserProfileName.trim();
    if (!name) return;
    const id = `profile-${crypto.randomUUID()}`;
    updateSettings({
      browserProfiles: [...settings.browserProfiles, { id, name, kind: "persistent" as const }],
    });
    setNewBrowserProfileName("");
  }, [newBrowserProfileName, settings.browserProfiles, updateSettings]);
  const removeBrowserProfile = useCallback(
    (id: string) => {
      updateSettings({
        browserProfiles: settings.browserProfiles.filter((profile) => profile.id !== id),
        ...(settings.browserDefaultProfileId === id
          ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
          : {}),
      });
      setBrowserProfileNames((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [settings.browserDefaultProfileId, settings.browserProfiles, updateSettings],
  );
  const selectedImportSource = browserImportSources.find(
    (source) => source.id === browserImportSourceId,
  );
  const loadBrowserImportSources = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const sources = await preview.listBrowserImportSources();
    setBrowserImportSources(sources);
    const first = sources.find(
      (source) => source.unavailable === undefined && source.profiles.length > 0,
    );
    if (first) {
      setBrowserImportSourceId(first.id);
      setBrowserImportProfileDirectory(first.profiles[0]?.directory ?? "");
    }
  }, []);
  useEffect(() => {
    void loadBrowserImportSources().catch((error: unknown) => {
      reportClientWarning("Failed to list browser cookie import sources", error);
    });
  }, [loadBrowserImportSources]);
  const importBrowserCookies = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (
      !preview ||
      !browserEnvironmentId ||
      !selectedImportSource ||
      !browserImportProfileDirectory ||
      !browserImportConsent
    )
      return;
    setBrowserImportStatus("Reading cookies...");
    try {
      const result = await preview.importBrowserCookies({
        environmentId: browserEnvironmentId,
        sourceId: selectedImportSource.id,
        sourceProfileDirectory: browserImportProfileDirectory,
        targetProfileId: importTargetProfile.id,
      });
      setBrowserImportStatus(
        `${result.imported} cookies imported${result.skipped > 0 ? `, ${result.skipped} skipped` : ""}.`,
      );
    } catch (error) {
      const reason = String(error).match(/: ([a-zA-Z]+)\.?$/)?.[1] as
        | keyof typeof BROWSER_IMPORT_FAILURE_COPY
        | undefined;
      setBrowserImportStatus(
        reason
          ? BROWSER_IMPORT_FAILURE_COPY[reason]
          : "Cookie import failed. Nothing was changed in the source browser.",
      );
    }
  }, [
    browserImportProfileDirectory,
    browserImportConsent,
    browserEnvironmentId,
    importTargetProfile.id,
    selectedImportSource,
  ]);
  // Collapsible state per provider-instance card, keyed by the instance id.
  // `Record<string, boolean>` so we don't need to preseed an entry for every
  // configured instance — an absent key reads as collapsed. Default-slot
  // rows share this state: their id is the driver slug
  // (`defaultInstanceIdForDriver(driver)`), which is also `ProviderDriverKind` at
  // runtime, so a pre-existing open key for e.g. "codex" persists across
  // the legacy/unified render swap.
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        reportClientWarning("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const delegatedThreadModelSelection = resolveDelegatedThreadModelSelectionState(
    settings,
    serverProviders,
  );
  const delegatedInstanceId = delegatedThreadModelSelection.instanceId;
  const delegatedModel = delegatedThreadModelSelection.model;
  const isDelegatedThreadModelDirty = !Equal.equals(
    settings.delegatedThreadModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.delegatedThreadModelSelection ?? null,
  );

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const chooseChatExportDirectory = useCallback(async () => {
    if (isPickingChatExportDirectory) {
      return;
    }
    setIsPickingChatExportDirectory(true);
    try {
      const pickedPath = await ensureLocalApi().dialogs.pickFolder(
        settings.chatExportDirectory ? { initialPath: settings.chatExportDirectory } : undefined,
      );
      if (pickedPath) {
        updateSettings({ chatExportDirectory: pickedPath });
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to choose export directory",
          description:
            error instanceof Error ? error.message : "An error occurred while opening the picker.",
        }),
      );
    } finally {
      setIsPickingChatExportDirectory(false);
    }
  }, [isPickingChatExportDirectory, settings.chatExportDirectory, updateSettings]);

  const exportActiveChats = useCallback(async () => {
    if (isExportingActiveChats) return;
    setIsExportingActiveChats(true);
    try {
      const result = await ensureLocalApi().server.exportActiveChats();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Exported ${result.threadCount} active chat${result.threadCount === 1 ? "" : "s"}`,
          description: result.path,
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not export active chats",
          description:
            error instanceof Error ? error.message : "An error occurred while exporting chats.",
        }),
      );
    } finally {
      setIsExportingActiveChats(false);
    }
  }, [isExportingActiveChats]);

  const importChatArchive = useCallback(async () => {
    if (isImportingChatArchive) return;
    setIsImportingChatArchive(true);
    try {
      const path = await ensureLocalApi().dialogs.pickFolder(
        settings.chatExportDirectory ? { initialPath: settings.chatExportDirectory } : undefined,
      );
      if (!path) return;
      const result = await ensureLocalApi().server.importChatArchive({ path });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Imported ${result.threadCount} chat${result.threadCount === 1 ? "" : "s"}`,
          description: "The chats are available in a new reference-only sidebar folder.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not import chat archive",
          description:
            error instanceof Error ? error.message : "An error occurred while importing chats.",
        }),
      );
    } finally {
      setIsImportingChatArchive(false);
    }
  }, [isImportingChatArchive, settings.chatExportDirectory]);

  const updateChatExportDetail = useCallback(
    (patch: Partial<typeof settings.chatExportDetail>) => {
      updateSettings({
        chatExportDetail: {
          ...settings.chatExportDetail,
          ...patch,
        },
      });
    },
    [settings.chatExportDetail, updateSettings],
  );

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  /**
   * Build the list of rows to render, one per configured instance. Each
   * row carries enough context to drive `ProviderInstanceCard` without
   * threading storage concerns: whether it's a built-in default slot (in
   * which case `isDefault` is true, deletion is gated off, and the
   * effective envelope may have been synthesized from legacy just for
   * this render), the driver kind narrow for the in-card model-slug
   * normalization, and whether a reset-to-factory action is warranted.
   *
   * Ordering mirrors the prior split: visible built-in default slots
   * first (one per visible kind), then user-authored custom instances
   * grouped by driver after their default sibling, then orphan instances
   * whose driver isn't in the visible-defaults set.
   */
  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    /** True for the slot whose id is `defaultInstanceIdForDriver(driver)`. */
    readonly isDefault: boolean;
    /**
     * True when this default slot differs from the factory defaults —
     * either through an explicit `providerInstances[defaultId]` entry,
     * or through a non-default legacy `settings.providers[kind]` struct
     * that we're still bridging. Used to show the reset-to-factory
     * affordance. Undefined for custom rows (they have a delete button
     * instead; "factory defaults" isn't meaningful).
     */
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    // Prefer an explicit `providerInstances[defaultId]` entry when one
    // exists (every edit via this UI promotes the default slot into
    // that map); fall back to synthesizing one from the legacy
    // `settings.providers[kind]` struct so first-time viewers still see
    // their persisted config.
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    // Non-default customs for this driver kind follow their default.
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  // Orphan instances: drivers the visible-defaults list doesn't cover
  // (e.g. Cursor when the server hasn't reported it but the user has
  // authored a Cursor instance anyway, or fork drivers not shipped by
  // this build). Preserve insertion order within each driver.
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      const isDefaultSlot = defaultSlotIdsBySource.has(String(id));
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: isDefaultSlot,
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  /**
   * Reset a built-in default slot back to factory defaults. Clears both
   * the legacy `settings.providers[kind]` struct and any explicit
   * `providerInstances[defaultId]` entry that has promoted legacy into
   * the new map, so hydration re-synthesizes a clean envelope on next
   * load. Safe to call on drivers that have never been edited.
   */
  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="UI density"
          description="Control spacing and type size across the entire interface — sidebar, chat, composer, and toolbars. Changing this applies the recommended font sizes for that density; each size stays adjustable below."
          resetAction={
            settings.uiDensity !== DEFAULT_UI_DENSITY ? (
              <SettingResetButton
                label="UI density"
                onClick={() =>
                  updateSettings({
                    uiDensity: DEFAULT_UI_DENSITY,
                    ...RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[DEFAULT_UI_DENSITY],
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (UI_DENSITY_OPTIONS.some((option) => option.value === value)) {
                  const density = value as UiDensity;
                  // Spacing alone cannot make a layout read as dense; the type
                  // scale has to move with it.
                  updateSettings({
                    uiDensity: density,
                    ...RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[density],
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="UI density">
                <SelectValue>
                  {UI_DENSITY_OPTIONS.find((option) => option.value === settings.uiDensity)
                    ?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_DENSITY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Sidebar translucency"
          description="Control the sidebar's frosted tint. Desktop builds use native vibrancy when available; browsers fall back to CSS blur."
          resetAction={
            settings.sidebarTranslucency !== DEFAULT_SIDEBAR_TRANSLUCENCY ? (
              <SettingResetButton
                label="sidebar translucency"
                onClick={() =>
                  updateSettings({ sidebarTranslucency: DEFAULT_SIDEBAR_TRANSLUCENCY })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarTranslucency}
              onValueChange={(value) => {
                if (
                  value === "off" ||
                  value === "subtle" ||
                  value === "medium" ||
                  value === "strong" ||
                  value === "liquid-glass"
                ) {
                  updateSettings({ sidebarTranslucency: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar translucency">
                <SelectValue>
                  {SIDEBAR_TRANSLUCENCY_OPTIONS.find(
                    (option) => option.value === settings.sidebarTranslucency,
                  )?.label ?? "Off"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SIDEBAR_TRANSLUCENCY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingsRow
          title="Inbox sidebar (beta)"
          description="Use the flat inbox with active, snoozed, and settled thread shelves."
          resetAction={
            settings.sidebarV2Enabled !== DEFAULT_SIDEBAR_V2_ENABLED ? (
              <SettingResetButton
                label="inbox sidebar"
                onClick={() => updateSettings({ sidebarV2Enabled: DEFAULT_SIDEBAR_V2_ENABLED })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarV2Enabled}
              onCheckedChange={(checked) => updateSettings({ sidebarV2Enabled: Boolean(checked) })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Header & sidebar buttons">
        <HeaderSidebarToggleRows
          rows={HEADER_VISIBILITY_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={PANEL_TOGGLE_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={SIDEBAR_VISIBILITY_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={HEADER_BEHAVIOR_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
      </SettingsSection>

      <SettingsSection title="Fonts">
        <SettingsRow
          title="Interface font"
          description="Choose the sans-serif typeface used throughout the app UI."
          resetAction={
            settings.uiFont !== DEFAULT_UI_FONT ? (
              <SettingResetButton
                label="interface font"
                onClick={() =>
                  updateSettings({
                    uiFont: DEFAULT_UI_FONT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiFont}
              onValueChange={(value) => {
                if (isUiFont(value)) {
                  updateSettings({ uiFont: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Interface font">
                <SelectValue>
                  {UI_FONT_OPTIONS.find((option) => option.value === settings.uiFont)?.label ??
                    "DM Sans"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font"
          description="Choose the monospace typeface used for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFont !== DEFAULT_CODE_FONT ? (
              <SettingResetButton
                label="code font"
                onClick={() =>
                  updateSettings({
                    codeFont: DEFAULT_CODE_FONT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.codeFont}
              onValueChange={(value) => {
                if (isCodeFont(value)) {
                  updateSettings({ codeFont: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font">
                <SelectValue>
                  {CODE_FONT_OPTIONS.find((option) => option.value === settings.codeFont)?.label ??
                    "System mono"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CODE_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font size"
          description="Font size for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFontSize !== recommendedFontSizes.codeFontSize ? (
              <SettingResetButton
                label="code font size"
                onClick={() =>
                  updateSettings({
                    codeFontSize: recommendedFontSizes.codeFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.codeFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ codeFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.codeFontSize)
                    ?.label ?? `${DEFAULT_CODE_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Chat font size"
          description="Font size for assistant and user messages in the chat."
          resetAction={
            settings.chatFontSize !== recommendedFontSizes.chatFontSize ? (
              <SettingResetButton
                label="chat font size"
                onClick={() =>
                  updateSettings({
                    chatFontSize: recommendedFontSizes.chatFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.chatFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ chatFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Chat font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.chatFontSize)
                    ?.label ?? `${DEFAULT_CHAT_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {(
          [
            {
              key: "normal",
              title: "Normal message preview",
              description: "Lines shown before expanding messages sent directly in a chat.",
            },
            {
              key: "crossThread",
              title: "Cross-thread message preview",
              description: "Lines shown before expanding messages sent from another chat.",
            },
            {
              key: "monitoring",
              title: "Monitoring message preview",
              description: "Lines shown before expanding pull request monitoring messages.",
            },
          ] as const
        ).map(({ key, title, description }) => (
          <SettingsRow
            key={key}
            title={title}
            description={description}
            resetAction={
              settings.messagePreviewLineLimits[key] !==
              DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS[key] ? (
                <SettingResetButton
                  label={title.toLowerCase()}
                  onClick={() =>
                    updateSettings({
                      messagePreviewLineLimits: {
                        ...settings.messagePreviewLineLimits,
                        [key]: DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS[key],
                      },
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={String(settings.messagePreviewLineLimits[key])}
                onValueChange={(value) => {
                  const lineCount = Number(value);
                  if (isMessagePreviewLineCount(lineCount)) {
                    updateSettings({
                      messagePreviewLineLimits: {
                        ...settings.messagePreviewLineLimits,
                        [key]: lineCount,
                      },
                    });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label={title}>
                  <SelectValue>
                    {formatMessagePreviewLineCount(settings.messagePreviewLineLimits[key])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {MESSAGE_PREVIEW_LINE_OPTIONS.map((lineCount) => (
                    <SelectItem hideIndicator key={lineCount} value={String(lineCount)}>
                      {formatMessagePreviewLineCount(lineCount)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ))}
        <SettingsRow
          title="Status line font size"
          description="Font size for assistant metadata lines, including timestamps, elapsed time, and resume commands."
          resetAction={
            settings.statusLineFontSize !== recommendedFontSizes.statusLineFontSize ? (
              <SettingResetButton
                label="status line font size"
                onClick={() =>
                  updateSettings({
                    statusLineFontSize: recommendedFontSizes.statusLineFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.statusLineFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ statusLineFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Status line font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.statusLineFontSize)
                    ?.label ?? `${DEFAULT_STATUS_LINE_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Input font size"
          description="Font size for the message composer, its controls, and menus."
          resetAction={
            settings.inputFontSize !== recommendedFontSizes.inputFontSize ? (
              <SettingResetButton
                label="input font size"
                onClick={() =>
                  updateSettings({
                    inputFontSize: recommendedFontSizes.inputFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.inputFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ inputFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Input font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.inputFontSize)
                    ?.label ?? `${DEFAULT_INPUT_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar font size"
          description="Font size for project and chat titles in the sidebar."
          resetAction={
            settings.sidebarFontSize !== recommendedFontSizes.sidebarFontSize ? (
              <SettingResetButton
                label="sidebar font size"
                onClick={() =>
                  updateSettings({
                    sidebarFontSize: recommendedFontSizes.sidebarFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ sidebarFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarFontSize)
                    ?.label ?? `${DEFAULT_SIDEBAR_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar metadata font size"
          description="Font size for the project name, worktree, branch, pull request, and timestamps on sidebar rows."
          resetAction={
            settings.sidebarMetaFontSize !== recommendedFontSizes.sidebarMetaFontSize ? (
              <SettingResetButton
                label="sidebar metadata font size"
                onClick={() =>
                  updateSettings({
                    sidebarMetaFontSize: recommendedFontSizes.sidebarMetaFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarMetaFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ sidebarMetaFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar metadata font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarMetaFontSize)
                    ?.label ?? `${DEFAULT_SIDEBAR_META_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar row spacing"
          description="Control the padding inside sidebar rows and the gap between them."
          resetAction={
            settings.sidebarRowSpacing !== DEFAULT_SIDEBAR_ROW_SPACING ? (
              <SettingResetButton
                label="sidebar row spacing"
                onClick={() => updateSettings({ sidebarRowSpacing: DEFAULT_SIDEBAR_ROW_SPACING })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarRowSpacing}
              onValueChange={(value) => {
                if (SIDEBAR_ROW_SPACING_OPTIONS.some((option) => option.value === value)) {
                  updateSettings({ sidebarRowSpacing: value as SidebarRowSpacing });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar row spacing">
                <SelectValue>
                  {SIDEBAR_ROW_SPACING_OPTIONS.find(
                    (option) => option.value === settings.sidebarRowSpacing,
                  )?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SIDEBAR_ROW_SPACING_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Tool output font size"
          description="Font size for work log entries and tool call output."
          resetAction={
            settings.toolFontSize !== recommendedFontSizes.toolFontSize ? (
              <SettingResetButton
                label="tool output font size"
                onClick={() =>
                  updateSettings({
                    toolFontSize: recommendedFontSizes.toolFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.toolFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ toolFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Tool output font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.toolFontSize)
                    ?.label ?? `${DEFAULT_TOOL_FONT_SIZE}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Pull request monitoring">
        <SettingsRow
          title="Automatically monitor associated PRs"
          description="Start durable monitoring when a chat creates or associates a pull request."
          resetAction={
            settings.autoMonitorPullRequestsOnCreate !==
            DEFAULT_UNIFIED_SETTINGS.autoMonitorPullRequestsOnCreate ? (
              <SettingResetButton
                label="automatic pull request monitoring"
                onClick={() =>
                  updateSettings({
                    autoMonitorPullRequestsOnCreate:
                      DEFAULT_UNIFIED_SETTINGS.autoMonitorPullRequestsOnCreate,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoMonitorPullRequestsOnCreate}
              onCheckedChange={(checked) =>
                updateSettings({ autoMonitorPullRequestsOnCreate: Boolean(checked) })
              }
              aria-label="Automatically monitor associated pull requests"
            />
          }
        />

        <SettingsRow
          title="Automatic maintenance chats"
          description="Create a prepared maintenance chat when feedback arrives and the owner chat is unavailable."
          resetAction={
            settings.autoLaunchPrMonitorFallback !==
            DEFAULT_UNIFIED_SETTINGS.autoLaunchPrMonitorFallback ? (
              <SettingResetButton
                label="automatic pull request maintenance chats"
                onClick={() =>
                  updateSettings({
                    autoLaunchPrMonitorFallback:
                      DEFAULT_UNIFIED_SETTINGS.autoLaunchPrMonitorFallback,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoLaunchPrMonitorFallback}
              onCheckedChange={(checked) =>
                updateSettings({ autoLaunchPrMonitorFallback: Boolean(checked) })
              }
              aria-label="Automatically create pull request maintenance chats"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Pull requests">
        <SettingsRow
          title="Default list state"
          description="State filter the pull requests page starts with when the URL names none."
          resetAction={
            settings.pullRequestsDefaultState !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestsDefaultState ? (
              <SettingResetButton
                label="pull requests default state"
                onClick={() =>
                  updateSettings({
                    pullRequestsDefaultState: DEFAULT_UNIFIED_SETTINGS.pullRequestsDefaultState,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.pullRequestsDefaultState}
              onValueChange={(value) => {
                if (isPullRequestListState(value)) {
                  updateSettings({ pullRequestsDefaultState: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Pull requests default state">
                <SelectValue>
                  {PULL_REQUESTS_STATE_OPTIONS.find(
                    (option) => option.value === settings.pullRequestsDefaultState,
                  )?.label ?? "Open"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PULL_REQUESTS_STATE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Diff code font size"
          description="Font size for code in pull request diffs."
          resetAction={
            settings.pullRequestsCodeFontSize !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestsCodeFontSize ? (
              <SettingResetButton
                label="pull requests code font size"
                onClick={() =>
                  updateSettings({
                    pullRequestsCodeFontSize: DEFAULT_UNIFIED_SETTINGS.pullRequestsCodeFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.pullRequestsCodeFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) {
                  updateSettings({ pullRequestsCodeFontSize: num });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Pull requests code font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find(
                    (option) => option.value === settings.pullRequestsCodeFontSize,
                  )?.label ?? "12px"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Wrap long diff lines"
          description="Wrap instead of horizontally scrolling long lines in pull request diffs."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="pull requests diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap long lines in pull request diffs"
            />
          }
        />
      </SettingsSection>

      <DeviceSettings />

      <SettingsSection title="Preferences">
        <SettingsRow
          title="Agent browser access"
          description="Let agents open and drive the preview browser. Turning this off withholds browser tools from newly started agent sessions. Externally managed OpenCode servers cannot receive per-thread browser credentials."
          resetAction={
            settings.enableAgentBrowserAccess !==
            DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
              <SettingResetButton
                label="agent browser access"
                onClick={() =>
                  updateSettings({
                    enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAgentBrowserAccess}
              onCheckedChange={(checked) =>
                updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
              }
              aria-label="Allow agent browser access"
            />
          }
        />

        <SettingsRow
          title="Agent browser preview"
          description="Show a floating browser or device preview when an agent uses automation."
          resetAction={
            settings.browserAutoShowFloatingPreview !==
            DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview ? (
              <SettingResetButton
                label="agent browser preview"
                onClick={() =>
                  updateSettings({
                    browserAutoShowFloatingPreview:
                      DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.browserAutoShowFloatingPreview}
              onCheckedChange={(checked) =>
                updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
              }
              aria-label="Show a floating preview during agent browser or device automation"
            />
          }
        />

        <SettingsRow
          title="Browser recording frame rate"
          description="Choose the frame rate for browser preview recordings."
          resetAction={
            settings.browserRecordingFrameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE ? (
              <SettingResetButton
                label="browser recording frame rate"
                onClick={() =>
                  updateSettings({
                    browserRecordingFrameRate: DEFAULT_BROWSER_RECORDING_FRAME_RATE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.browserRecordingFrameRate)}
              onValueChange={(value) => {
                if (value === "30" || value === "60") {
                  updateSettings({ browserRecordingFrameRate: Number(value) as 30 | 60 });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser recording frame rate">
                <SelectValue>{settings.browserRecordingFrameRate} fps</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="30">
                  30 fps
                </SelectItem>
                <SelectItem hideIndicator value="60">
                  60 fps
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser default viewport"
          description="Choose the viewport size used by new browser tabs unless an entry point provides an explicit size."
          resetAction={
            settings.browserDefaultViewport._tag !== FILL_PREVIEW_VIEWPORT._tag ? (
              <SettingResetButton
                label="browser default viewport"
                onClick={() => updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT })}
              />
            ) : null
          }
          control={
            <Select
              value={
                settings.browserDefaultViewport._tag === "fill"
                  ? "fill"
                  : `${settings.browserDefaultViewport.width}x${settings.browserDefaultViewport.height}`
              }
              onValueChange={(value) => {
                if (value === null) return;
                const next: Record<string, PreviewViewportSetting> = {
                  fill: FILL_PREVIEW_VIEWPORT,
                  "1440x900": { _tag: "freeform", width: 1440, height: 900 },
                  "1024x768": { _tag: "freeform", width: 1024, height: 768 },
                  "390x844": { _tag: "freeform", width: 390, height: 844 },
                };
                const viewport = next[value];
                if (viewport) updateSettings({ browserDefaultViewport: viewport });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default viewport">
                <SelectValue>
                  {settings.browserDefaultViewport._tag === "fill"
                    ? "Panel size"
                    : `${settings.browserDefaultViewport.width} x ${settings.browserDefaultViewport.height}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="fill">
                  Panel size
                </SelectItem>
                <SelectItem hideIndicator value="1440x900">
                  Desktop (1440 x 900)
                </SelectItem>
                <SelectItem hideIndicator value="1024x768">
                  Tablet (1024 x 768)
                </SelectItem>
                <SelectItem hideIndicator value="390x844">
                  Mobile (390 x 844)
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser default zoom"
          description="Set the initial zoom factor for human and agent browser tabs."
          resetAction={
            settings.browserDefaultZoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
              <SettingResetButton
                label="browser default zoom"
                onClick={() =>
                  updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.browserDefaultZoomFactor)}
              onValueChange={(value) => {
                const zoom = Number(value);
                if ([0.8, 1, 1.25, 1.5].includes(zoom)) {
                  updateSettings({
                    browserDefaultZoomFactor: zoom as typeof settings.browserDefaultZoomFactor,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default zoom">
                <SelectValue>{Math.round(settings.browserDefaultZoomFactor * 100)}%</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {[0.8, 1, 1.25, 1.5].map((zoom) => (
                  <SelectItem hideIndicator key={zoom} value={String(zoom)}>
                    {Math.round(zoom * 100)}%
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser default appearance"
          description="Choose the color scheme applied when a new browser tab is created."
          resetAction={
            settings.browserDefaultAppearance !== DEFAULT_PREVIEW_APPEARANCE ? (
              <SettingResetButton
                label="browser default appearance"
                onClick={() =>
                  updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.browserDefaultAppearance}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  updateSettings({
                    browserDefaultAppearance: value as PreviewAppearancePreference,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default appearance">
                <SelectValue>
                  {settings.browserDefaultAppearance === "system"
                    ? "System"
                    : settings.browserDefaultAppearance === "light"
                      ? "Light"
                      : "Dark"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="system">
                  System
                </SelectItem>
                <SelectItem hideIndicator value="light">
                  Light
                </SelectItem>
                <SelectItem hideIndicator value="dark">
                  Dark
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Open links in"
          description="Choose whether HTTP(S) links open in T3 Code or your system browser. Cmd/Ctrl/Shift/Alt-click always opens externally."
          resetAction={
            settings.browserLinkTarget !== DEFAULT_BROWSER_LINK_TARGET ? (
              <SettingResetButton
                label="link destination"
                onClick={() => updateSettings({ browserLinkTarget: DEFAULT_BROWSER_LINK_TARGET })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.browserLinkTarget}
              onValueChange={(value) => {
                if (value === "system" || value === "app") {
                  updateSettings({ browserLinkTarget: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Open links in">
                <SelectValue>
                  {settings.browserLinkTarget === "app" ? "T3 Code" : "System browser"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="app">
                  T3 Code
                </SelectItem>
                <SelectItem hideIndicator value="system">
                  System browser
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser profiles"
          description="Keep cookies and site storage separate between named profiles. Incognito tabs are cleared when the app closes."
          control={
            <Select
              value={settings.browserDefaultProfileId}
              onValueChange={(value) => {
                if (value !== null) updateSettings({ browserDefaultProfileId: value });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Default browser profile">
                <SelectValue>
                  {browserProfiles.find(
                    (profile) => profile.id === settings.browserDefaultProfileId,
                  )?.name ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {browserProfiles
                  .filter((profile) => profile.kind !== "incognito")
                  .map((profile) => (
                    <SelectItem hideIndicator key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="space-y-2 pb-4 pt-3">
            {browserProfiles.map((profile) => {
              const builtIn =
                profile.id === DEFAULT_BROWSER_PROFILE_ID || profile.kind === "incognito";
              return (
                <div key={profile.id} className="flex items-center gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    value={browserProfileNames[profile.id] ?? profile.name}
                    disabled={builtIn}
                    aria-label={`${profile.name} profile name`}
                    onChange={(event) =>
                      setBrowserProfileNames((current) => ({
                        ...current,
                        [profile.id]: event.target.value,
                      }))
                    }
                    onBlur={() => updateBrowserProfileName(profile)}
                  />
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {profile.kind === "incognito"
                      ? "Incognito"
                      : profile.id === settings.browserDefaultProfileId
                        ? "Default"
                        : ""}
                  </span>
                  {!builtIn ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete ${profile.name} profile`}
                      onClick={() => removeBrowserProfile(profile.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <div className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                value={newBrowserProfileName}
                onChange={(event) => setNewBrowserProfileName(event.target.value)}
                placeholder="New profile name"
                aria-label="New browser profile name"
                onKeyDown={(event) => {
                  if (event.key === "Enter") addBrowserProfile();
                }}
              />
              <Button
                size="xs"
                variant="outline"
                onClick={addBrowserProfile}
                disabled={!newBrowserProfileName.trim()}
              >
                <PlusIcon className="size-3.5" />
                Add
              </Button>
            </div>
            <div className="border-t border-border pt-3">
              <div className="text-xs font-medium">Import cookies from another browser</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Imports cookies only into the selected T3 Code profile. Passwords and browser
                history are never copied. Quit the source browser before importing.
              </p>
              <div className="mt-3 space-y-2">
                <Select
                  value={browserImportSourceId}
                  onValueChange={(value) => {
                    if (!value) return;
                    const source = browserImportSources.find((candidate) => candidate.id === value);
                    setBrowserImportSourceId(value as BrowserImportSourceId);
                    setBrowserImportProfileDirectory(source?.profiles[0]?.directory ?? "");
                    setBrowserImportStatus(null);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Cookie import source browser">
                    <SelectValue placeholder="Choose source browser">
                      {selectedImportSource?.name ?? "Choose source browser"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {browserImportSources.map((source) => (
                      <SelectItem hideIndicator key={source.id} value={source.id}>
                        {source.name}
                        {source.unavailable
                          ? ` — ${BROWSER_IMPORT_UNAVAILABLE_COPY[source.unavailable]}`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {selectedImportSource?.unavailable ? (
                  <p className="text-xs text-muted-foreground">
                    {BROWSER_IMPORT_UNAVAILABLE_COPY[selectedImportSource.unavailable]}
                  </p>
                ) : null}
                {selectedImportSource && selectedImportSource.profiles.length > 0 ? (
                  <Select
                    value={browserImportProfileDirectory}
                    onValueChange={(value) => {
                      if (value) setBrowserImportProfileDirectory(value);
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Cookie import source profile">
                      <SelectValue placeholder="Choose source profile">
                        {selectedImportSource.profiles.find(
                          (profile) => profile.directory === browserImportProfileDirectory,
                        )?.name ?? "Choose source profile"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {selectedImportSource.profiles.map((profile) => (
                        <SelectItem hideIndicator key={profile.directory} value={profile.directory}>
                          {profile.name}
                          {profile.cookieCount === undefined
                            ? ""
                            : ` (${profile.cookieCount} cookies)`}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                <Select
                  value={importTargetProfile.id}
                  onValueChange={(value) => {
                    if (value) setBrowserImportTargetProfileId(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Cookie import target profile">
                    <SelectValue>Import into {importTargetProfile.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {browserProfiles
                      .filter((profile) => profile.kind !== "incognito")
                      .map((profile) => (
                        <SelectItem hideIndicator key={profile.id} value={profile.id}>
                          {profile.name}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={browserImportConsent}
                    onCheckedChange={(checked) => setBrowserImportConsent(checked === true)}
                    aria-label="Allow cookie import"
                  />
                  <span>
                    I understand this reads cookies from the selected browser profile and adds them
                    to T3 Code.
                  </span>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !browserEnvironmentId ||
                    !browserImportConsent ||
                    !selectedImportSource ||
                    selectedImportSource.unavailable !== undefined ||
                    !browserImportProfileDirectory
                  }
                  onClick={() => void importBrowserCookies()}
                >
                  Import cookies
                </Button>
                {browserImportStatus ? (
                  <p className="text-xs text-muted-foreground">{browserImportStatus}</p>
                ) : null}
              </div>
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Completion notifications"
          description="Show macOS notifications when a chat finishes."
          resetAction={
            settings.threadCompletionNotifications !==
            DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE ? (
              <SettingResetButton
                label="completion notifications"
                onClick={() =>
                  updateSettings({
                    threadCompletionNotifications: DEFAULT_THREAD_COMPLETION_NOTIFICATION_MODE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.threadCompletionNotifications}
              onValueChange={(value) => {
                if (value === "off" || value === "background-only" || value === "all") {
                  updateSettings({ threadCompletionNotifications: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Completion notifications">
                <SelectValue>
                  {THREAD_COMPLETION_NOTIFICATION_OPTIONS.find(
                    (option) => option.value === settings.threadCompletionNotifications,
                  )?.label ?? "Background only"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THREAD_COMPLETION_NOTIFICATION_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Auto-open task panel"
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task sidebar automatically"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Chat export directory"
          description="Markdown exports and bulk chat archive folders are saved here."
          resetAction={
            settings.chatExportDirectory !== DEFAULT_UNIFIED_SETTINGS.chatExportDirectory ? (
              <SettingResetButton
                label="chat export directory"
                onClick={() =>
                  updateSettings({
                    chatExportDirectory: DEFAULT_UNIFIED_SETTINGS.chatExportDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <DraftInput
                className="w-full sm:w-72"
                value={settings.chatExportDirectory}
                onCommit={(next) => updateSettings({ chatExportDirectory: next })}
                placeholder="~/t3-chat-exports"
                spellCheck={false}
                aria-label="Chat export directory"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void chooseChatExportDirectory()}
                disabled={isPickingChatExportDirectory}
              >
                {isPickingChatExportDirectory ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <FolderOpenIcon className="size-3.5" />
                )}
                Choose
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Transfer active chats"
          description="Export every non-archived chat, or import a T3 chat archive as a reference-only sidebar folder."
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void exportActiveChats()}
                disabled={
                  isExportingActiveChats ||
                  isImportingChatArchive ||
                  settings.chatExportDirectory.trim().length === 0
                }
              >
                {isExportingActiveChats ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <ArchiveIcon className="size-3.5" />
                )}
                Export active chats
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void importChatArchive()}
                disabled={isImportingChatArchive || isExportingActiveChats}
              >
                {isImportingChatArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <FolderOpenIcon className="size-3.5" />
                )}
                Import chat folder
              </Button>
            </div>
          }
        />

        <SettingsRow
          title="Chat export details"
          description="Choose which extra sections are included in exported Markdown chat files."
          resetAction={
            !Equal.equals(settings.chatExportDetail, DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS) ? (
              <SettingResetButton
                label="chat export details"
                onClick={() =>
                  updateSettings({
                    chatExportDetail: DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="grid w-full gap-2 sm:w-80">
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Thread and session metadata</span>
                <Switch
                  checked={settings.chatExportDetail.includeMetadata}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeMetadata: Boolean(checked) })
                  }
                  aria-label="Include metadata in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Tool calls and activity</span>
                <Switch
                  checked={settings.chatExportDetail.includeToolCalls}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeToolCalls: Boolean(checked) })
                  }
                  aria-label="Include tool calls in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Diffs and checkpoints</span>
                <Switch
                  checked={settings.chatExportDetail.includeDiffs}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeDiffs: Boolean(checked) })
                  }
                  aria-label="Include diffs in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Proposed plans</span>
                <Switch
                  checked={settings.chatExportDetail.includePlans}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includePlans: Boolean(checked) })
                  }
                  aria-label="Include proposed plans in chat exports"
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-xs text-foreground">
                <span>Queued turns</span>
                <Switch
                  checked={settings.chatExportDetail.includeQueuedTurns}
                  onCheckedChange={(checked) =>
                    updateChatExportDetail({ includeQueuedTurns: Boolean(checked) })
                  }
                  aria-label="Include queued turns in chat exports"
                />
              </label>
            </div>
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Configure the model used for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isGitWritingModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={gitModelInstanceEntries}
                modelOptionsByInstance={gitModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // Use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />

        <SettingsRow
          title="Delegated thread model"
          description="Default model for helper threads created via delegate_work when no explicit model is given. Explicit per-delegation models always win."
          resetAction={
            isDelegatedThreadModelDirty ? (
              <SettingResetButton
                label="delegated thread model"
                onClick={() =>
                  updateSettings({
                    delegatedThreadModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.delegatedThreadModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={delegatedInstanceId}
                model={delegatedModel}
                lockedProvider={null}
                instanceEntries={gitModelInstanceEntries}
                modelOptionsByInstance={gitModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    delegatedThreadModelSelection: resolveDelegatedThreadModelSelectionState(
                      {
                        ...settings,
                        delegatedThreadModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) => {
          const driverOption = getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = (settings.favorites ?? [])
            .filter((favorite) => favorite.provider === row.instanceId)
            .map((favorite) => favorite.model);
          const resetLabel = driverOption?.label ?? String(row.driver);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              automaticPrFeedback={settings.copilotAutomaticPrFeedback[row.instanceId] === true}
              onAutomaticPrFeedbackChange={(enabled) =>
                updateSettings({ copilotAutomaticPrFeedback: { [row.instanceId]: enabled } })
              }
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) => {
                // When the user disables the exact instance the text-gen
                // selection points at, fall back to the global default so we
                // don't leave the selection dangling on a disabled instance.
                // Prior kind-level behavior cleared on any kind-matching
                // disable; instance-level addressing makes this narrower and
                // more accurate (other instances of the same kind stay
                // untouched).
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
            />
          );
        })}
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />

      <SettingsSection title="Advanced">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogsDirectory}
              onClick={openLogsDirectory}
            >
              {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const DEFAULT_COLLABORATIVE_ACCEPTANCE_POLICY: CollaborativeAcceptancePolicy = {
  automation: "bounded",
  reviewTrigger: "first-candidate",
  reviewWorkflow: { identity: "review-changes", version: "1" },
  commentPolicy: "blocking-only",
  budgets: {
    exchanges: 3,
    modelSpendCents: 0,
    retries: 1,
    disputeRounds: 1,
    executionDurationSeconds: 0,
    waitingDeadlineSeconds: 0,
  },
};

function CollaborativeAcceptanceSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const policy = settings.collaborativeAcceptance;
  const configuredPolicy = policy ?? DEFAULT_COLLABORATIVE_ACCEPTANCE_POLICY;
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  const updatePolicy = useCallback(
    (patch: CollaborativeAcceptancePolicyPatch) => {
      const currentPolicy = policyRef.current;
      if (!currentPolicy) return;
      const nextPolicy = mergeCollaborativeAcceptancePolicy(currentPolicy, patch);
      if (nextPolicy.automation === "bounded" && nextPolicy.budgets.exchanges < 1) {
        setValidationMessage("Bounded automation needs at least one parent-child exchange.");
        return;
      }
      if (
        nextPolicy.reviewWorkflow.identity.trim().length === 0 ||
        nextPolicy.reviewWorkflow.version.trim().length === 0
      ) {
        setValidationMessage("Choose a review workflow identity and version.");
        return;
      }
      setValidationMessage(null);
      policyRef.current = nextPolicy;
      updateSettings({ collaborativeAcceptance: nextPolicy });
    },
    [updateSettings],
  );

  const updateBudget = useCallback(
    (key: keyof CollaborativeAcceptancePolicy["budgets"], value: string) => {
      const parsed = Number.parseInt(value.trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setValidationMessage("Limits must be zero or greater.");
        return;
      }
      updatePolicy({ budgets: { [key]: parsed } });
    },
    [updatePolicy],
  );

  return (
    <SettingsSection title="PR collaboration automation">
      <SettingsRow
        title="Automation policy"
        description="Choose whether the coordinator may exchange parent and child reviews. Existing users stay opted out until they choose a policy."
        control={
          <Select
            value={policy?.automation ?? "unconfigured"}
            onValueChange={(value) => {
              if (value === "unconfigured") {
                policyRef.current = null;
                updateSettings({ collaborativeAcceptance: null });
                setValidationMessage(null);
                return;
              }
              const nextPolicy = mergeCollaborativeAcceptancePolicy(
                policyRef.current ?? DEFAULT_COLLABORATIVE_ACCEPTANCE_POLICY,
                {
                  automation: value as CollaborativeAcceptancePolicy["automation"],
                },
              );
              policyRef.current = nextPolicy;
              updateSettings({ collaborativeAcceptance: nextPolicy });
              setValidationMessage(null);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              aria-label="PR collaboration automation policy"
            >
              <SelectValue>
                {policy
                  ? COLLABORATIVE_ACCEPTANCE_AUTOMATION_OPTIONS.find(
                      (option) => option.value === policy.automation,
                    )?.label
                  : "Not configured"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="unconfigured">
                Not configured
              </SelectItem>
              {COLLABORATIVE_ACCEPTANCE_AUTOMATION_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <div
        className={policy ? undefined : "pointer-events-none opacity-50"}
        aria-disabled={!policy}
      >
        <SettingsRow
          title="Exchange budget"
          description="Limit parent-child review exchanges, not raw assistant turns."
          control={
            <DraftInput
              value={String(configuredPolicy.budgets.exchanges)}
              inputMode="numeric"
              onCommit={(value) => updateBudget("exchanges", value)}
              aria-label="Parent-child exchange budget"
            />
          }
        />
        <SettingsRow
          title="Review trigger"
          description="Choose when the coordinator requests a review of an eligible candidate."
          control={
            <Select
              value={configuredPolicy.reviewTrigger}
              onValueChange={(value) => {
                if (
                  value === "manual" ||
                  value === "first-candidate" ||
                  value === "each-eligible-candidate"
                ) {
                  updatePolicy({ reviewTrigger: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="PR review trigger">
                <SelectValue>
                  {
                    COLLABORATIVE_ACCEPTANCE_TRIGGER_OPTIONS.find(
                      (option) => option.value === configuredPolicy.reviewTrigger,
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {COLLABORATIVE_ACCEPTANCE_TRIGGER_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Review workflow"
          description="Use the canonical workflow identity and version for candidate reviews."
        >
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DraftInput
              value={configuredPolicy.reviewWorkflow.identity}
              onCommit={(identity) =>
                updatePolicy({
                  reviewWorkflow: { identity: identity.trim() },
                })
              }
              aria-label="Collaborative review workflow identity"
              placeholder="Workflow identity"
            />
            <DraftInput
              value={configuredPolicy.reviewWorkflow.version}
              onCommit={(version) =>
                updatePolicy({
                  reviewWorkflow: { version: version.trim() },
                })
              }
              aria-label="Collaborative review workflow version"
              placeholder="Workflow version"
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="PR feedback policy"
          description="Decide which findings must be addressed before acceptance."
          control={
            <Select
              value={configuredPolicy.commentPolicy}
              onValueChange={(value) => {
                if (
                  value === "blocking-only" ||
                  value === "all-actionable-addressed" ||
                  value === "all-review-threads-resolved"
                ) {
                  updatePolicy({ commentPolicy: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="PR feedback policy">
                <SelectValue>
                  {
                    COLLABORATIVE_ACCEPTANCE_COMMENT_OPTIONS.find(
                      (option) => option.value === configuredPolicy.commentPolicy,
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {COLLABORATIVE_ACCEPTANCE_COMMENT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Advanced limits"
          description="Set independent zero-or-greater limits. Zero means no limit where supported."
        >
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(
              [
                ["modelSpendCents", "Model spend (cents)"],
                ["retries", "Retries"],
                ["disputeRounds", "Dispute rounds"],
                ["executionDurationSeconds", "Execution duration (seconds)"],
                ["waitingDeadlineSeconds", "Waiting deadline (seconds)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                {label}
                <DraftInput
                  value={String(configuredPolicy.budgets[key])}
                  inputMode="numeric"
                  onCommit={(value) => updateBudget(key, value)}
                  aria-label={label}
                />
              </label>
            ))}
          </div>
        </SettingsRow>
      </div>
      <div className="px-4 pb-4 pt-3 text-xs sm:px-5" aria-live="polite">
        {validationMessage ? (
          <p className="text-destructive">{validationMessage}</p>
        ) : policy ? (
          <p className="text-muted-foreground">
            {policy.automation === "bounded"
              ? "Bounded mode is enabled with an explicit exchange budget."
              : policy.automation === "until-ready"
                ? "The coordinator may continue until the backend reports Ready now or a limit blocks it."
                : "Collaboration is explicitly disabled."}
          </p>
        ) : (
          <p className="text-muted-foreground">
            Not configured. Selecting a policy opts this account into PR collaboration automation.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

export function PullRequestCollaborationSettingsPanel() {
  return (
    <SettingsPageContainer>
      <CollaborativeAcceptanceSettingsPanel />
    </SettingsPageContainer>
  );
}

export function AgentWorkflowsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const customWorkflows = settings.agentWorkflows.customWorkflows;

  const updateAgentWorkflows = useCallback(
    (patch: Partial<typeof settings.agentWorkflows>) => {
      updateSettings({
        agentWorkflows: {
          ...settings.agentWorkflows,
          ...patch,
        },
      });
    },
    [settings.agentWorkflows, updateSettings],
  );

  const updateReviewChangesWorkflow = useCallback(
    (patch: Partial<typeof settings.agentWorkflows.reviewChanges>) => {
      updateAgentWorkflows({
        reviewChanges: {
          ...settings.agentWorkflows.reviewChanges,
          ...patch,
        },
      });
    },
    [settings.agentWorkflows.reviewChanges, updateAgentWorkflows],
  );

  const updateFixReviewIssuesWorkflow = useCallback(
    (patch: Partial<typeof settings.agentWorkflows.fixReviewIssues>) => {
      updateAgentWorkflows({
        fixReviewIssues: {
          ...settings.agentWorkflows.fixReviewIssues,
          ...patch,
        },
      });
    },
    [settings.agentWorkflows.fixReviewIssues, updateAgentWorkflows],
  );

  const updateCustomWorkflows = useCallback(
    (nextCustomWorkflows: typeof customWorkflows) => {
      updateAgentWorkflows({ customWorkflows: nextCustomWorkflows });
    },
    [customWorkflows, updateAgentWorkflows],
  );

  const addCustomWorkflow = useCallback(() => {
    updateCustomWorkflows([
      ...customWorkflows,
      {
        id: `custom-${crypto.randomUUID()}`,
        enabled: true,
        name: "New workflow",
        buttonLabel: "Run",
        promptTemplate: "",
        showInHeader: true,
        destinationMode: "child-chat",
        automation: {
          afterAssistantTurnCompletes: false,
          cooldownMs: DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS,
          maxRunsPerThread: DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD,
        },
      },
    ]);
  }, [customWorkflows, updateCustomWorkflows]);

  const updateCustomWorkflow = useCallback(
    (workflowId: string, patch: Partial<(typeof customWorkflows)[number]>) => {
      updateCustomWorkflows(
        customWorkflows.map((workflow) =>
          workflow.id === workflowId ? { ...workflow, ...patch } : workflow,
        ),
      );
    },
    [customWorkflows, updateCustomWorkflows],
  );

  const deleteCustomWorkflow = useCallback(
    (workflowId: string) => {
      updateCustomWorkflows(customWorkflows.filter((workflow) => workflow.id !== workflowId));
    },
    [customWorkflows, updateCustomWorkflows],
  );

  const commitRequiredCustomText = useCallback(
    (workflowId: string, key: "name" | "buttonLabel", value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: key === "name" ? "Workflow name is required" : "Button label is required",
        });
        return;
      }
      updateCustomWorkflow(workflowId, { [key]: trimmed });
    },
    [updateCustomWorkflow],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Built-in workflows">
        <SettingsRow
          title="Review Code"
          description="Show the Review Code header action and allow it to create review chats."
          resetAction={
            settings.agentWorkflows.reviewChanges.enabled !==
            DEFAULT_UNIFIED_SETTINGS.agentWorkflows.reviewChanges.enabled ? (
              <SettingResetButton
                label="Review Code workflow enabled state"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    enabled: DEFAULT_UNIFIED_SETTINGS.agentWorkflows.reviewChanges.enabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.agentWorkflows.reviewChanges.enabled}
              onCheckedChange={(checked) =>
                updateReviewChangesWorkflow({ enabled: Boolean(checked) })
              }
              aria-label="Enable Review Code workflow"
            />
          }
        >
          <div className="mt-4">
            <WorkflowModelControls
              modelSelection={settings.agentWorkflows.reviewChanges.modelSelection}
              onModelSelectionChange={(modelSelection) =>
                updateReviewChangesWorkflow({ modelSelection })
              }
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Review scope"
          description="Default scope for the Review Code button. The dropdown can still run either scope."
          resetAction={
            settings.agentWorkflows.reviewChanges.defaultScope !== DEFAULT_REVIEW_CHANGES_SCOPE ? (
              <SettingResetButton
                label="Review Code default scope"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    defaultScope: DEFAULT_REVIEW_CHANGES_SCOPE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.agentWorkflows.reviewChanges.defaultScope}
              onValueChange={(value) => {
                if (isReviewChangesScope(value)) {
                  updateReviewChangesWorkflow({ defaultScope: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Review Code default scope">
                <SelectValue>
                  {REVIEW_CHANGES_SCOPE_OPTIONS.find(
                    (option) => option.value === settings.agentWorkflows.reviewChanges.defaultScope,
                  )?.label ?? "Uncommitted changes"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {REVIEW_CHANGES_SCOPE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Review prompt"
          description="Instructions inserted after the fixed scope context. Leave blank to use the built-in default prompt."
          resetAction={
            settings.agentWorkflows.reviewChanges.promptTemplate !==
            DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE ? (
              <SettingResetButton
                label="Review Code prompt"
                onClick={() =>
                  updateReviewChangesWorkflow({
                    promptTemplate: DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
                  })
                }
              />
            ) : null
          }
        >
          <WorkflowPromptTemplateEditor
            value={settings.agentWorkflows.reviewChanges.promptTemplate}
            onCommit={(promptTemplate) => updateReviewChangesWorkflow({ promptTemplate })}
            placeholder={DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE}
            ariaLabel="Review Code prompt template"
          />
        </SettingsRow>

        <SettingsRow
          title="Fix Review Issues"
          description="Show a Fix button on review results and allow it to create a child chat."
          resetAction={
            settings.agentWorkflows.fixReviewIssues.enabled !==
            DEFAULT_UNIFIED_SETTINGS.agentWorkflows.fixReviewIssues.enabled ? (
              <SettingResetButton
                label="Fix Review Issues workflow enabled state"
                onClick={() =>
                  updateFixReviewIssuesWorkflow({
                    enabled: DEFAULT_UNIFIED_SETTINGS.agentWorkflows.fixReviewIssues.enabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.agentWorkflows.fixReviewIssues.enabled}
              onCheckedChange={(checked) =>
                updateFixReviewIssuesWorkflow({ enabled: Boolean(checked) })
              }
              aria-label="Enable Fix Review Issues workflow"
            />
          }
        >
          <div className="mt-4">
            <WorkflowModelControls
              modelSelection={settings.agentWorkflows.fixReviewIssues.modelSelection}
              onModelSelectionChange={(modelSelection) =>
                updateFixReviewIssuesWorkflow({ modelSelection })
              }
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Fix prompt"
          description="Instructions placed before the review issues. Leave blank to use the built-in default prompt."
          resetAction={
            settings.agentWorkflows.fixReviewIssues.promptTemplate !==
            DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE ? (
              <SettingResetButton
                label="Fix Review Issues prompt"
                onClick={() =>
                  updateFixReviewIssuesWorkflow({
                    promptTemplate: DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE,
                  })
                }
              />
            ) : null
          }
        >
          <WorkflowPromptTemplateEditor
            value={settings.agentWorkflows.fixReviewIssues.promptTemplate}
            onCommit={(promptTemplate) => updateFixReviewIssuesWorkflow({ promptTemplate })}
            placeholder={DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE}
            ariaLabel="Fix Review Issues prompt template"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Custom workflows"
        headerAction={
          <Button size="xs" variant="outline" onClick={addCustomWorkflow}>
            <PlusIcon className="size-3.5" />
            Add workflow
          </Button>
        }
      >
        {customWorkflows.length === 0 ? (
          <SettingsRow
            title="No custom workflows"
            description="Create a prompt-only workflow to show it in the chat header."
          />
        ) : (
          customWorkflows.map((workflow) => (
            <div key={workflow.id} className="border-t border-border/60 first:border-t-0">
              <SettingsRow
                title={workflow.name}
                description="Configure the workflow display, destination, and prompt."
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={workflow.enabled}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, { enabled: Boolean(checked) })
                      }
                      aria-label={`Enable ${workflow.name}`}
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${workflow.name}`}
                      onClick={() => deleteCustomWorkflow(workflow.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                }
              >
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <DraftInput
                    value={workflow.name}
                    onCommit={(value) => commitRequiredCustomText(workflow.id, "name", value)}
                    placeholder="Workflow name"
                    aria-label={`${workflow.name} workflow name`}
                  />
                  <DraftInput
                    value={workflow.buttonLabel}
                    onCommit={(value) =>
                      commitRequiredCustomText(workflow.id, "buttonLabel", value)
                    }
                    placeholder="Button label"
                    aria-label={`${workflow.name} button label`}
                  />
                  <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-xs text-muted-foreground">Show in chat header</span>
                    <Switch
                      checked={workflow.showInHeader}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, { showInHeader: Boolean(checked) })
                      }
                      aria-label={`Show ${workflow.name} in header`}
                    />
                  </div>
                  <Select
                    value={workflow.destinationMode}
                    onValueChange={(value) => {
                      if (isAgentWorkflowDestinationMode(value)) {
                        updateCustomWorkflow(workflow.id, { destinationMode: value });
                      }
                    }}
                  >
                    <SelectTrigger aria-label={`${workflow.name} destination`}>
                      <SelectValue>
                        {WORKFLOW_DESTINATION_OPTIONS.find(
                          (option) => option.value === workflow.destinationMode,
                        )?.label ?? "Child chat"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {WORKFLOW_DESTINATION_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <WorkflowModelControls
                    modelSelection={workflow.modelSelection}
                    onModelSelectionChange={(modelSelection) =>
                      updateCustomWorkflow(workflow.id, { modelSelection })
                    }
                  />
                  <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      Run after assistant completes
                    </span>
                    <Switch
                      checked={workflow.automation.afterAssistantTurnCompletes}
                      onCheckedChange={(checked) =>
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            afterAssistantTurnCompletes: Boolean(checked),
                          },
                        })
                      }
                      aria-label={`Run ${workflow.name} after assistant completes`}
                    />
                  </div>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Cooldown seconds
                    <DraftInput
                      value={String(Math.round(workflow.automation.cooldownMs / 1000))}
                      inputMode="numeric"
                      onCommit={(value) => {
                        const seconds = Number.parseInt(value.trim(), 10);
                        if (!Number.isFinite(seconds) || seconds < 0) {
                          toastManager.add({
                            type: "warning",
                            title: "Cooldown must be zero or greater",
                          });
                          return;
                        }
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            cooldownMs: seconds * 1000,
                          },
                        });
                      }}
                      aria-label={`${workflow.name} automation cooldown seconds`}
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Max runs per thread
                    <DraftInput
                      value={String(workflow.automation.maxRunsPerThread)}
                      inputMode="numeric"
                      onCommit={(value) => {
                        const maxRunsPerThread = Number.parseInt(value.trim(), 10);
                        if (!Number.isFinite(maxRunsPerThread) || maxRunsPerThread < 0) {
                          toastManager.add({
                            type: "warning",
                            title: "Max runs must be zero or greater",
                          });
                          return;
                        }
                        updateCustomWorkflow(workflow.id, {
                          automation: {
                            ...workflow.automation,
                            maxRunsPerThread,
                          },
                        });
                      }}
                      aria-label={`${workflow.name} automation max runs per thread`}
                    />
                  </label>
                </div>
                <WorkflowPromptTemplateEditor
                  value={workflow.promptTemplate}
                  onCommit={(promptTemplate) =>
                    updateCustomWorkflow(workflow.id, { promptTemplate })
                  }
                  placeholder="Enter workflow instructions"
                  ariaLabel={`${workflow.name} prompt template`}
                />
              </SettingsRow>
            </div>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const environmentIds = useStore(
    useShallow((state) => Object.keys(state.environmentStateById) as EnvironmentId[]),
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const { unarchiveThread, deleteThread, confirmAndDeleteThread } = useThreadActions();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedThreadKeys, setSelectedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const archivedGroups = useMemo(() => {
    return buildArchivedThreadGroupsFromSnapshots({ snapshots });
  }, [snapshots]);
  const archivedThreads = useMemo(
    () => archivedGroups.flatMap((group) => group.threads),
    [archivedGroups],
  );
  const filteredArchivedGroups = useMemo(
    () => filterArchivedThreadGroups(archivedGroups, searchQuery),
    [archivedGroups, searchQuery],
  );
  const filteredThreadKeys = useMemo(
    () =>
      filteredArchivedGroups.flatMap(({ threads: projectThreads }) =>
        projectThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [filteredArchivedGroups],
  );
  const archivedThreadKeys = useMemo(
    () =>
      new Set(
        archivedGroups.flatMap(({ threads: projectThreads }) =>
          projectThreads.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        ),
      ),
    [archivedGroups],
  );
  const selectedThreadCount = selectedThreadKeys.size;

  useEffect(() => {
    setSelectedThreadKeys((current) => {
      const next = new Set([...current].filter((threadKey) => archivedThreadKeys.has(threadKey)));
      return next.size === current.size ? current : next;
    });
  }, [archivedThreadKeys]);

  const toggleThreadSelection = useCallback((threadKey: string) => {
    setSelectedThreadKeys((current) => {
      const next = new Set(current);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return next;
    });
  }, []);

  const selectAllFilteredThreads = useCallback(() => {
    setSelectedThreadKeys((current) => new Set([...current, ...filteredThreadKeys]));
  }, [filteredThreadKeys]);

  const clearSelection = useCallback(() => {
    setSelectedThreadKeys(new Set());
  }, []);

  const unarchiveSelectedThreads = useCallback(async () => {
    const selectedThreads = archivedGroups.flatMap(({ threads: projectThreads }) =>
      projectThreads.flatMap((thread) => {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        return selectedThreadKeys.has(scopedThreadKey(threadRef))
          ? [{ key: scopedThreadKey(threadRef), threadRef }]
          : [];
      }),
    );
    const results = await Promise.allSettled(
      selectedThreads.map(({ threadRef }) => unarchiveThread(threadRef)),
    );
    const failedThreadKeys = new Set(
      selectedThreads.flatMap(({ key }, index) =>
        results[index]?.status === "rejected" ? [key] : [],
      ),
    );
    const failedCount = failedThreadKeys.size;
    if (failedCount > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to unarchive some threads",
          description: `${failedCount} thread${failedCount === 1 ? "" : "s"} could not be unarchived.`,
        }),
      );
    }
    setSelectedThreadKeys(failedThreadKeys);
  }, [archivedGroups, selectedThreadKeys, unarchiveThread]);

  const deleteSelectedThreads = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    const selectedThreads = archivedGroups.flatMap(({ project, threads: projectThreads }) =>
      projectThreads.flatMap((thread) => {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        return selectedThreadKeys.has(scopedThreadKey(threadRef))
          ? [{ key: scopedThreadKey(threadRef), project, thread, threadRef }]
          : [];
      }),
    );
    if (confirmThreadDelete) {
      const count = selectedThreads.length;
      const confirmed = await api.dialogs.confirm(
        [
          `Delete ${count} chat${count === 1 ? "" : "s"}?`,
          "This permanently clears conversation history for these chats.",
        ].join("\n"),
      );
      if (!confirmed) return;
    }

    const deletedThreadKeys = new Set(selectedThreadKeys);
    const results = await runSequentiallySettled(
      selectedThreads,
      ({ project, thread, threadRef }) =>
        deleteThread(threadRef, {
          deletedThreadKeys,
          archivedContext: {
            project,
            thread,
            threads: archivedThreads.filter(
              (archivedThread) => archivedThread.environmentId === thread.environmentId,
            ),
          },
        }),
    );
    const failedThreadKeys = new Set(
      selectedThreads.flatMap(({ key }, index) =>
        results[index]?.status === "rejected" ? [key] : [],
      ),
    );
    if (failedThreadKeys.size > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to delete some chats",
          description: `${failedThreadKeys.size} chat${failedThreadKeys.size === 1 ? "" : "s"} could not be deleted.`,
        }),
      );
    }
    setSelectedThreadKeys(failedThreadKeys);
  }, [archivedGroups, archivedThreads, confirmThreadDelete, deleteThread, selectedThreadKeys]);

  const handleArchivedThreadContextMenu = useCallback(
    async (
      project: (typeof archivedGroups)[number]["project"],
      thread: (typeof archivedGroups)[number]["threads"][number],
      position: { x: number; y: number },
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef, {
          archivedContext: {
            project,
            thread,
            threads: archivedThreads.filter(
              (archivedThread) => archivedThread.environmentId === thread.environmentId,
            ),
          },
        });
      }
    },
    [archivedThreads, confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {isLoading && archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <LoaderIcon className="animate-spin" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Loading archived threads</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : error && archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Could not load archived threads</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          </Empty>
        </SettingsSection>
      ) : archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="Archived threads">
            {error ? (
              <div className="border-b border-border p-4 sm:px-5">
                <Alert variant="error">
                  <CircleAlertIcon />
                  <AlertTitle>Could not refresh archived threads</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                  <AlertAction>
                    <Button variant="outline" size="xs" onClick={refresh}>
                      <RefreshCwIcon className="size-3.5" />
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              </div>
            ) : null}
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
              <div className="relative flex-1">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search archived chats..."
                  aria-label="Search archived chats"
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filteredThreadKeys.length === 0}
                  onClick={selectAllFilteredThreads}
                >
                  Select all
                </Button>
                {selectedThreadCount > 0 ? (
                  <>
                    <Button variant="outline" size="sm" onClick={clearSelection}>
                      Clear selection
                    </Button>
                    <Button size="sm" onClick={() => void unarchiveSelectedThreads()}>
                      <ArchiveX className="size-3.5" />
                      Unarchive {selectedThreadCount}
                    </Button>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      onClick={() => void deleteSelectedThreads()}
                    >
                      <Trash2Icon className="size-3.5" />
                      Delete {selectedThreadCount}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </SettingsSection>
          {filteredArchivedGroups.length === 0 ? (
            <SettingsSection title="Search results">
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyTitle>No archived chats found</EmptyTitle>
                  <EmptyDescription>Try another search term.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </SettingsSection>
          ) : (
            filteredArchivedGroups.map(({ project, threads: projectThreads }) => (
              <SettingsSection
                key={`${project.environmentId}:${project.id}`}
                title={project.name}
                icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
              >
                {projectThreads.map((thread) => {
                  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                  const threadKey = scopedThreadKey(threadRef);
                  return (
                    <div
                      key={thread.id}
                      className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                      onContextMenu={(event) => {
                        event.preventDefault();
                        void handleArchivedThreadContextMenu(project, thread, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <Checkbox
                        checked={selectedThreadKeys.has(threadKey)}
                        onCheckedChange={() => toggleThreadSelection(threadKey)}
                        aria-label={`Select ${thread.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                          {" \u00b7 Created "}
                          {formatRelativeTimeLabel(thread.createdAt)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                        onClick={() =>
                          void unarchiveThread(threadRef)
                            .then(() => {
                              setSelectedThreadKeys((current) => {
                                if (!current.has(threadKey)) {
                                  return current;
                                }
                                const next = new Set(current);
                                next.delete(threadKey);
                                return next;
                              });
                            })
                            .catch((error) => {
                              toastManager.add(
                                stackedThreadToast({
                                  type: "error",
                                  title: "Failed to unarchive thread",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                }),
                              );
                            })
                        }
                      >
                        <ArchiveX className="size-3.5" />
                        <span>Unarchive</span>
                      </Button>
                    </div>
                  );
                })}
              </SettingsSection>
            ))
          )}
        </>
      )}
    </SettingsPageContainer>
  );
}
