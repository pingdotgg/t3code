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
]);
export type ShellAction = typeof ShellAction.Type;

/** `window.t3Shell`, injected by the shell before any page script runs. */
export interface T3Shell {
  readonly protocolVersion: number;
  readonly ready: Promise<unknown>;
  publish(key: string, value: unknown): Promise<void>;
  onAction(listener: (action: string, payload: unknown) => void): Promise<void>;
}
