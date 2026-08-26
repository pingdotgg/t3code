import * as Schema from "effect/Schema";

/**
 * Contract between the web app and a native shell hosting it (the Qt shell
 * in apps/desktop-qt). The shell exposes `window.t3Shell`; the page publishes
 * derived view models with `publish(key, value)` and receives user intent
 * from shell-rendered chrome as actions. The page stays the only client of
 * the server; the shell never sees the app protocol.
 */
export const SHELL_PROTOCOL_VERSION = 1 as const;

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

/** Published under the `composer` key while a thread or draft route is open. */
export const ShellComposerState = Schema.Struct({
  /** `<environmentId>:<threadId>` or a draft id; null between routes. */
  target: Schema.NullOr(Schema.String),
  routeKind: Schema.Literals(["server", "draft"]),
  text: Schema.String,
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

/** Actions the shell's chrome dispatches; `type` is the action name on the wire. */
export const ShellAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread.open"), key: Schema.String }),
  Schema.Struct({ type: Schema.Literal("draft.open"), draftId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thread.new"), projectKey: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("sidebar.scope"),
    projectKey: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("project.add") }),
  Schema.Struct({ type: Schema.Literal("settings.open") }),
  Schema.Struct({ type: Schema.Literal("pullRequests.open") }),
  Schema.Struct({ type: Schema.Literal("usage.open") }),
  Schema.Struct({ type: Schema.Literal("palette.open") }),
  Schema.Struct({ type: Schema.Literal("composer.text.set"), text: Schema.String }),
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
  Schema.Struct({ type: Schema.Literal("rightPanel.activate"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("rightPanel.close"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("rightPanel.add"),
    kind: Schema.Literals(["diff", "files", "terminal", "pullRequest", "agents"]),
  }),
]);
export type ShellAction = typeof ShellAction.Type;

/** `window.t3Shell`, injected by the shell before any page script runs. */
export interface T3Shell {
  readonly protocolVersion: number;
  readonly ready: Promise<unknown>;
  publish(key: string, value: unknown): Promise<void>;
  /** Resolves to an unsubscribe function once the channel is connected. */
  onAction(listener: (action: string, payload: unknown) => void): Promise<() => void>;
  /** Everything published so far, keyed as published (any document's view models). */
  getState(): Promise<Readonly<Record<string, unknown>>>;
  /** Calls `listener` now and on every publish; resolves to an unsubscribe function. */
  onState(listener: (state: Readonly<Record<string, unknown>>) => void): Promise<() => void>;
}
