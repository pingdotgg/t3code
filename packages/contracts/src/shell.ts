import * as Schema from "effect/Schema";

/**
 * Contract between the web app and a native shell hosting it (the Qt shell
 * in apps/desktop-qt). The shell exposes `window.t3Shell`; the page publishes
 * derived view models with `publish(key, value)` and receives user intent
 * from shell-rendered chrome as actions. The page stays the only client of
 * the server; the shell never sees the app protocol.
 *
 * Imported as `@t3tools/contracts/shell` so only shell-hosted code pulls
 * these schemas into its bundle.
 */

export const ShellSidebarThreadStatus = Schema.Literals([
  "approval",
  "input",
  "working",
  "monitoring",
  "failed",
  "ready",
]);
export type ShellSidebarThreadStatus = typeof ShellSidebarThreadStatus.Type;

export const ShellSidebarThread = Schema.Struct({
  /** `<environmentId>:<threadId>`, the key `thread.open` sends back. */
  key: Schema.String,
  threadId: Schema.String,
  environmentId: Schema.String,
  /** Logical (grouped) project key, matching `ShellSidebarProject.key`. */
  projectKey: Schema.String,
  title: Schema.String,
  status: ShellSidebarThreadStatus,
  statusLabel: Schema.NullOr(Schema.String),
  unread: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  pinned: Schema.Boolean,
  snoozedUntil: Schema.NullOr(Schema.String),
});
export type ShellSidebarThread = typeof ShellSidebarThread.Type;

export const ShellSidebarProject = Schema.Struct({
  key: Schema.String,
  displayName: Schema.String,
  environmentId: Schema.String,
  projectId: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: Schema.Number,
});
export type ShellSidebarProject = typeof ShellSidebarProject.Type;

export const ShellSidebarDraft = Schema.Struct({
  draftId: Schema.String,
  projectKey: Schema.String,
  label: Schema.String,
});
export type ShellSidebarDraft = typeof ShellSidebarDraft.Type;

/** Published under the `sidebar` key: the thread list already bucketed and sorted. */
export const ShellSidebarState = Schema.Struct({
  projects: Schema.Array(ShellSidebarProject),
  scopeProjectKey: Schema.NullOr(Schema.String),
  pinned: Schema.Array(ShellSidebarThread),
  active: Schema.Array(ShellSidebarThread),
  snoozed: Schema.Array(ShellSidebarThread),
  settled: Schema.Array(ShellSidebarThread),
  settledTotal: Schema.Number,
  drafts: Schema.Array(ShellSidebarDraft),
  activeThreadKey: Schema.NullOr(Schema.String),
  activeDraftId: Schema.NullOr(Schema.String),
});
export type ShellSidebarState = typeof ShellSidebarState.Type;

/**
 * Published under the `layout` key by the page's sidebar provider: the
 * collapse state the page owns (its keybinding toggles it), for the shell to
 * animate its own chrome.
 */
export const ShellLayoutState = Schema.Struct({
  sidebarCollapsed: Schema.Boolean,
});
export type ShellLayoutState = typeof ShellLayoutState.Type;

export const ShellComposerModel = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  disabledReason: Schema.NullOr(Schema.String),
});
export type ShellComposerModel = typeof ShellComposerModel.Type;

export const ShellComposerInstance = Schema.Struct({
  instanceId: Schema.String,
  driverKind: Schema.String,
  displayName: Schema.String,
  isAvailable: Schema.Boolean,
  models: Schema.Array(ShellComposerModel),
});
export type ShellComposerInstance = typeof ShellComposerInstance.Type;

/** A provider option (reasoning effort, thinking toggles, …) for the selected model. */
export const ShellComposerOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["select", "boolean"]),
  value: Schema.NullOr(Schema.Union([Schema.String, Schema.Boolean])),
  choices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export type ShellComposerOption = typeof ShellComposerOption.Type;

export const ShellComposerRuntimeMode = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.String,
});
export type ShellComposerRuntimeMode = typeof ShellComposerRuntimeMode.Type;

export const ShellComposerSuggestion = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["path", "slash-command", "provider-slash-command", "skill"]),
  label: Schema.String,
  description: Schema.String,
});
export type ShellComposerSuggestion = typeof ShellComposerSuggestion.Type;

/** Published under the `composer` key while a thread or draft route is open. */
export const ShellComposerState = Schema.Struct({
  /** `<environmentId>:<threadId>` or a draft id; null between routes. */
  target: Schema.NullOr(Schema.String),
  routeKind: Schema.Literals(["server", "draft"]),
  text: Schema.String,
  /** Caret position in `text` (raw prompt, mentions written out) after the page changed it. */
  cursor: Schema.Number,
  /** Active `@`/`$`/`/` trigger at the caret, with what it resolves to. */
  triggerKind: Schema.NullOr(Schema.Literals(["path", "slash-command", "skill"])),
  suggestions: Schema.Array(ShellComposerSuggestion),
  suggestionsEmptyText: Schema.NullOr(Schema.String),
  /** Attached images and terminal selections on the draft (removable chips). */
  attachments: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  terminalContexts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      lineStart: Schema.Number,
      lineEnd: Schema.Number,
    }),
  ),
  placeholder: Schema.String,
  editorDisabled: Schema.Boolean,
  canSend: Schema.Boolean,
  sendDisabledReason: Schema.NullOr(Schema.String),
  isRunning: Schema.Boolean,
  isSendBusy: Schema.Boolean,
  isConnecting: Schema.Boolean,
  pendingApprovalCount: Schema.Number,
  pendingUserInputCount: Schema.Number,
  showPlanFollowUpPrompt: Schema.Boolean,
  selectedInstanceId: Schema.NullOr(Schema.String),
  selectedModel: Schema.NullOr(Schema.String),
  instances: Schema.Array(ShellComposerInstance),
  options: Schema.Array(ShellComposerOption),
  runtimeMode: Schema.String,
  runtimeModes: Schema.Array(ShellComposerRuntimeMode),
  interactionMode: Schema.Literals(["default", "plan"]),
  showInteractionModeToggle: Schema.Boolean,
});
export type ShellComposerState = typeof ShellComposerState.Type;

export const ShellRightPanelKind = Schema.Literals([
  "diff",
  "files",
  "file",
  "preview",
  "terminal",
  "pull-request",
  "agents",
]);
export type ShellRightPanelKind = typeof ShellRightPanelKind.Type;

export const ShellRightPanelSurface = Schema.Struct({
  id: Schema.String,
  kind: ShellRightPanelKind,
  title: Schema.String,
});
export type ShellRightPanelSurface = typeof ShellRightPanelSurface.Type;

/**
 * Published under the `rightPanel` key while a thread route is open. The
 * panel's content stays HTML: the shell loads `embedPath` (same origin as the
 * page, same session) in a second web view; this state only drives the tabs.
 */
export const ShellRightPanelState = Schema.Struct({
  threadKey: Schema.String,
  isOpen: Schema.Boolean,
  activeSurfaceId: Schema.NullOr(Schema.String),
  surfaces: Schema.Array(ShellRightPanelSurface),
  canAdd: Schema.Struct({
    diff: Schema.Boolean,
    files: Schema.Boolean,
    terminal: Schema.Boolean,
    pullRequest: Schema.Boolean,
    agents: Schema.Boolean,
  }),
  embedPath: Schema.String,
});
export type ShellRightPanelState = typeof ShellRightPanelState.Type;

export const ShellWorkspaceEnvMode = Schema.Literals(["local", "worktree"]);
export type ShellWorkspaceEnvMode = typeof ShellWorkspaceEnvMode.Type;

/**
 * Published under the `workspace` key while a thread route is open: the
 * breadcrumb, checkout/branch context, editors and project scripts. Git
 * write actions (commit/push/PR) stay with the page's own control.
 */
export const ShellWorkspaceState = Schema.Struct({
  threadKey: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  projectRoot: Schema.NullOr(Schema.String),
  threadTitle: Schema.String,
  isDraft: Schema.Boolean,
  envMode: ShellWorkspaceEnvMode,
  envModeLabel: Schema.String,
  envModeChangeable: Schema.Boolean,
  startFromOrigin: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  git: Schema.NullOr(
    Schema.Struct({
      isRepo: Schema.Boolean,
      hasWorkingTreeChanges: Schema.Boolean,
      aheadCount: Schema.Number,
      behindCount: Schema.Number,
      hasUpstream: Schema.Boolean,
      pullRequest: Schema.NullOr(
        Schema.Struct({
          number: Schema.Number,
          title: Schema.String,
          url: Schema.String,
          state: Schema.String,
        }),
      ),
    }),
  ),
  canOpenPullRequest: Schema.Boolean,
  /** The thread's terminal drawer: whether one can open here, and whether it is open. */
  terminalAvailable: Schema.Boolean,
  terminalOpen: Schema.Boolean,
  editors: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  preferredEditorId: Schema.NullOr(Schema.String),
  scripts: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, command: Schema.String }),
  ),
  preferredScriptId: Schema.NullOr(Schema.String),
  environments: Schema.Array(Schema.Struct({ environmentId: Schema.String, label: Schema.String })),
  activeEnvironmentId: Schema.String,
  environmentChangeable: Schema.Boolean,
  /** Bumped when the page asks the shell to start renaming the thread. */
  renameRequestId: Schema.Number,
  /** Ref list for `branchQuery` (first pages), for a native branch picker. */
  branchQuery: Schema.String,
  branches: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      isRemote: Schema.Boolean,
      isDefault: Schema.Boolean,
      current: Schema.Boolean,
    }),
  ),
  branchesTotal: Schema.Number,
  branchesLoading: Schema.Boolean,
  branchSwitchPending: Schema.Boolean,
  branchChangeable: Schema.Boolean,
});
export type ShellWorkspaceState = typeof ShellWorkspaceState.Type;

/** Published under the `settings` key on every route change. */
export const ShellSettingsState = Schema.Struct({
  /** True on `/settings*`: the shell shows settings navigation instead of the thread sidebar. */
  active: Schema.Boolean,
  sections: Schema.Array(Schema.Struct({ to: Schema.String, label: Schema.String })),
  activeSection: Schema.NullOr(Schema.String),
  searchQuery: Schema.String,
  searchResults: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      to: Schema.String,
      sectionLabel: Schema.String,
      targetId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ShellSettingsState = typeof ShellSettingsState.Type;

/**
 * Published under the `theme` key: the page's resolved active theme, so the
 * shell's default look is whatever the user picked in Settings. Colours are
 * theme roles (see ThemeColorRole) resolved to `#rrggbb[aa]`.
 */
export const ShellThemeState = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  appearance: Schema.Literals(["light", "dark"]),
  colors: Schema.Record(Schema.String, Schema.String),
  /** `--radius` in CSS pixels. */
  radius: Schema.Number,
  fontUi: Schema.NullOr(Schema.String),
  fontMono: Schema.NullOr(Schema.String),
});
export type ShellThemeState = typeof ShellThemeState.Type;

export const ShellNotification = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["error", "info", "loading", "success", "warning"]),
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Bumped when the page updates the toast in place. */
  updateKey: Schema.Number,
  actions: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, primary: Schema.Boolean }),
  ),
});
export type ShellNotification = typeof ShellNotification.Type;

/** Published under the `notifications` key: the page's stacked toasts, newest first. */
export const ShellNotificationsState = Schema.Struct({
  items: Schema.Array(ShellNotification),
});
export type ShellNotificationsState = typeof ShellNotificationsState.Type;

const ShellContextMenuLeaf = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  header: Schema.optional(Schema.Boolean),
  separatorBefore: Schema.optional(Schema.Boolean),
});
export const ShellContextMenuItem = Schema.Struct({
  ...ShellContextMenuLeaf.fields,
  children: Schema.optional(Schema.Array(ShellContextMenuLeaf)),
});
export type ShellContextMenuItem = typeof ShellContextMenuItem.Type;

/**
 * Published under the `contextMenu` key while the page waits for a choice:
 * every `localApi.contextMenu.show` becomes a native menu. `surfaceId` names
 * the web surface whose coordinates `x`/`y` are in (`"shell"` = window
 * coordinates, for menus opened from native chrome). Null when closed.
 */
export const ShellContextMenuState = Schema.Struct({
  requestId: Schema.Number,
  surfaceId: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  items: Schema.Array(ShellContextMenuItem),
});
export type ShellContextMenuState = typeof ShellContextMenuState.Type;

export const ShellGitMenuItem = Schema.Struct({
  id: Schema.Literals(["commit", "push", "pr"]),
  label: Schema.String,
  disabledReason: Schema.NullOr(Schema.String),
});
export type ShellGitMenuItem = typeof ShellGitMenuItem.Type;

/**
 * Published under the `git` key while a thread route is open: the git
 * control's model. Progress and results arrive as notifications; the commit
 * and default-branch dialogs are the shell's to render from this state.
 */
export const ShellGitState = Schema.Struct({
  available: Schema.Boolean,
  isRepo: Schema.Boolean,
  busy: Schema.Boolean,
  initPending: Schema.Boolean,
  quickAction: Schema.Struct({
    label: Schema.String,
    disabledReason: Schema.NullOr(Schema.String),
    kind: Schema.Literals(["run_action", "run_pull", "open_pr", "open_publish", "show_hint"]),
  }),
  menu: Schema.Array(ShellGitMenuItem),
  canPublish: Schema.Boolean,
  hints: Schema.Array(Schema.String),
  branch: Schema.NullOr(Schema.String),
  isDefaultRef: Schema.Boolean,
  /** Working-tree files for the commit dialog. */
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, insertions: Schema.Number, deletions: Schema.Number }),
  ),
  /** Set while the page waits for the default-branch confirmation. */
  pendingDefaultBranch: Schema.NullOr(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
      continueLabel: Schema.String,
      featureBranchLabel: Schema.String,
    }),
  ),
});
export type ShellGitState = typeof ShellGitState.Type;

/** Actions the shell's chrome dispatches; `type` is the action name on the wire. */
export const ShellAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread.open"), key: Schema.String }),
  Schema.Struct({ type: Schema.Literal("draft.open"), draftId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thread.new"), projectKey: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("sidebar.scope"),
    projectKey: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("sidebar.toggle") }),
  Schema.Struct({ type: Schema.Literal("project.add") }),
  Schema.Struct({ type: Schema.Literal("settings.open") }),
  Schema.Struct({ type: Schema.Literal("pullRequests.open") }),
  Schema.Struct({ type: Schema.Literal("usage.open") }),
  Schema.Struct({ type: Schema.Literal("palette.open") }),
  Schema.Struct({
    type: Schema.Literal("composer.text.set"),
    text: Schema.String,
    /** Caret in `text`; drives @/$// suggestions. */
    cursor: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("composer.suggest.select"), id: Schema.String }),
  /** Files the shell read for the user (drop or picker); go through the drop pipeline. */
  Schema.Struct({
    type: Schema.Literal("composer.attach"),
    files: Schema.Array(
      Schema.Struct({ name: Schema.String, mimeType: Schema.String, base64: Schema.String }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("composer.attachment.remove"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("composer.terminalContext.remove"), id: Schema.String }),
  /** A terminal selection from any document, added to the primary's composer. */
  Schema.Struct({
    type: Schema.Literal("composer.terminalContext.add"),
    terminalId: Schema.String,
    terminalLabel: Schema.String,
    lineStart: Schema.Number,
    lineEnd: Schema.Number,
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("composer.suggest.dismiss") }),
  // `text` rides along so the send is atomic with the latest edit.
  Schema.Struct({
    type: Schema.Literal("composer.submit"),
    text: Schema.optional(Schema.String),
    intent: Schema.optional(Schema.Literals(["foreground", "background"])),
  }),
  Schema.Struct({ type: Schema.Literal("composer.interrupt") }),
  Schema.Struct({
    type: Schema.Literal("composer.model.select"),
    instanceId: Schema.String,
    model: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("composer.option.set"),
    id: Schema.String,
    value: Schema.Union([Schema.String, Schema.Boolean]),
  }),
  Schema.Struct({ type: Schema.Literal("composer.runtimeMode.set"), mode: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("composer.interactionMode.set"),
    mode: Schema.Literals(["default", "plan"]),
  }),
  Schema.Struct({ type: Schema.Literal("rightPanel.toggle") }),
  Schema.Struct({ type: Schema.Literal("terminal.toggle") }),
  Schema.Struct({ type: Schema.Literal("rightPanel.activate"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("rightPanel.close"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("rightPanel.add"),
    kind: Schema.Literals(["diff", "files", "terminal", "pull-request", "agents"]),
  }),
  Schema.Struct({ type: Schema.Literal("workspace.newThread") }),
  Schema.Struct({
    type: Schema.Literal("workspace.openInEditor"),
    editorId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("workspace.runScript"), scriptId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("workspace.envMode.set"), mode: ShellWorkspaceEnvMode }),
  Schema.Struct({ type: Schema.Literal("workspace.startFromOrigin.set"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("workspace.openPullRequest") }),
  Schema.Struct({
    type: Schema.Literal("workspace.environment.set"),
    environmentId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("workspace.branch.search"), query: Schema.String }),
  Schema.Struct({ type: Schema.Literal("workspace.branch.select"), name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("workspace.branch.create"), name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("settings.navigate"), to: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("settings.openResult"),
    to: Schema.String,
    targetId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("settings.search"), query: Schema.String }),
  Schema.Struct({ type: Schema.Literal("settings.back") }),
  Schema.Struct({
    type: Schema.Literal("notification.action"),
    id: Schema.String,
    actionId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("notification.dismiss"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("contextMenu.select"),
    requestId: Schema.Number,
    id: Schema.NullOr(Schema.String),
  }),
  /** Open the thread's action menu at window coordinates. */
  Schema.Struct({
    type: Schema.Literal("workspace.titleMenu"),
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("workspace.rename"), title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("git.quick") }),
  Schema.Struct({
    type: Schema.Literal("git.menu"),
    id: Schema.Literals(["commit", "push", "pr"]),
  }),
  Schema.Struct({ type: Schema.Literal("git.init") }),
  Schema.Struct({ type: Schema.Literal("git.publish") }),
  Schema.Struct({ type: Schema.Literal("git.refresh") }),
  Schema.Struct({
    type: Schema.Literal("git.commit"),
    message: Schema.String,
    /** Null commits everything; otherwise the chosen subset. */
    filePaths: Schema.NullOr(Schema.Array(Schema.String)),
    featureBranch: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("git.defaultBranch"),
    choice: Schema.Literals(["abort", "continue", "featureBranch"]),
  }),
  /** Open a sidebar thread's action menu at window coordinates. */
  Schema.Struct({
    type: Schema.Literal("thread.menu"),
    key: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
  }),
]);
export type ShellAction = typeof ShellAction.Type;

/** `window.t3Shell`, injected by the shell before any page script runs. */
export interface T3Shell {
  readonly protocolVersion: number;
  /** Which web surface this document is in (`"primary"`, `"rightPanel"`, …). */
  readonly surfaceId: string;
  readonly ready: Promise<unknown>;
  publish(key: string, value: unknown): Promise<void>;
  /** Resolves to an unsubscribe function once the channel is connected. */
  onAction(listener: (action: string, payload: unknown) => void): Promise<() => void>;
  /** Everything published so far, keyed as published (any document's view models). */
  getState(): Promise<Readonly<Record<string, unknown>>>;
  /** Calls `listener` now and on every publish; resolves to an unsubscribe function. */
  onState(listener: (state: Readonly<Record<string, unknown>>) => void): Promise<() => void>;
  /** Dispatch an action as native chrome would (lets a secondary document reach the primary). */
  dispatch(action: string, payload?: unknown): Promise<void>;
}
