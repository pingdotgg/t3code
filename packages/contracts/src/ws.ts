import { Schema } from "effect";

import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsInput,
} from "./orchestration";
import {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitPullInput,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitStatusInput,
} from "./git";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import { ProjectSearchEntriesInput } from "./project";
import { OpenInEditorInput } from "./editor";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverUpsertKeybinding: "server.upsertKeybinding",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  terminalEvent: "terminal.event",
  serverWelcome: "server.welcome",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

export const WebSocketRequestBody = Schema.TaggedUnion({
  // Orchestration methods
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: { command: ClientOrchestrationCommand },
  [ORCHESTRATION_WS_METHODS.getSnapshot]: OrchestrationGetSnapshotInput.fields,
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: OrchestrationGetTurnDiffInput.fields,
  [ORCHESTRATION_WS_METHODS.replayEvents]: OrchestrationReplayEventsInput.fields,

  // Project Search
  [WS_METHODS.projectsSearchEntries]: ProjectSearchEntriesInput.fields,

  // Shell methods
  [WS_METHODS.shellOpenInEditor]: OpenInEditorInput.fields,

  // Git methods
  [WS_METHODS.gitPull]: GitPullInput.fields,
  [WS_METHODS.gitStatus]: GitStatusInput.fields,
  [WS_METHODS.gitRunStackedAction]: GitRunStackedActionInput.fields,
  [WS_METHODS.gitListBranches]: GitListBranchesInput.fields,
  [WS_METHODS.gitCreateWorktree]: GitCreateWorktreeInput.fields,
  [WS_METHODS.gitRemoveWorktree]: GitRemoveWorktreeInput.fields,
  [WS_METHODS.gitCreateBranch]: GitCreateBranchInput.fields,
  [WS_METHODS.gitCheckout]: GitCheckoutInput.fields,
  [WS_METHODS.gitInit]: GitInitInput.fields,

  // Terminal methods
  [WS_METHODS.terminalOpen]: TerminalOpenInput.fields,
  [WS_METHODS.terminalWrite]: TerminalWriteInput.fields,
  [WS_METHODS.terminalResize]: TerminalResizeInput.fields,
  [WS_METHODS.terminalClear]: TerminalClearInput.fields,
  [WS_METHODS.terminalRestart]: TerminalRestartInput.fields,
  [WS_METHODS.terminalClose]: TerminalCloseInput.fields,

  // Server meta
  [WS_METHODS.serverGetConfig]: {},
  [WS_METHODS.serverUpsertKeybinding]: KeybindingRule.fields,
});

export const WebSocketRequest = Schema.Struct({
  id: Schema.String,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;


export class WebSocketResponse extends Schema.Class<WebSocketResponse>("WebSocketResponse")({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
}) {}

export class WsPush extends Schema.Class<WsPush>("WsPushEvent")({
  type: Schema.Literal("push"),
  channel: Schema.String,
  data: Schema.Unknown,
}) {}

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;

// ── Server welcome payload ───────────────────────────────────────────

export class WsWelcomePayload extends Schema.Class<WsWelcomePayload>("WsWelcomePayload")({
  cwd: Schema.String,
  projectName: Schema.String,
}) {}
