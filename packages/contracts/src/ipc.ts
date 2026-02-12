import type { AgentConfig, AgentExit, OutputChunk } from "./agent";
import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProviderEvent,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "./provider";
import type {
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
} from "./project";
import type { TerminalCommandInput, TerminalCommandResult } from "./terminal";
import type { NewTodoInput, Todo } from "./todo";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export type EditorId = (typeof EDITORS)[number]["id"];

export interface NativeApi {
  todos: {
    list: () => Promise<Todo[]>;
    add: (input: NewTodoInput) => Promise<Todo[]>;
    toggle: (id: string) => Promise<Todo[]>;
    remove: (id: string) => Promise<Todo[]>;
  };
  dialogs: {
    pickFolder: () => Promise<string | null>;
  };
  terminal: {
    run: (input: TerminalCommandInput) => Promise<TerminalCommandResult>;
  };
  agent: {
    spawn: (config: AgentConfig) => Promise<string>;
    kill: (sessionId: string) => Promise<void>;
    write: (sessionId: string, data: string) => Promise<void>;
    onOutput: (callback: (chunk: OutputChunk) => void) => () => void;
    onExit: (callback: (exit: AgentExit) => void) => () => void;
  };
  providers: {
    startSession: (input: ProviderSessionStartInput) => Promise<ProviderSession>;
    sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;
    interruptTurn: (input: ProviderInterruptTurnInput) => Promise<void>;
    respondToRequest: (input: ProviderRespondToRequestInput) => Promise<void>;
    stopSession: (input: ProviderStopSessionInput) => Promise<void>;
    listSessions: () => Promise<ProviderSession[]>;
    onEvent: (callback: (event: ProviderEvent) => void) => () => void;
  };
  projects: {
    list: () => Promise<ProjectListResult>;
    add: (input: ProjectAddInput) => Promise<ProjectAddResult>;
    remove: (input: ProjectRemoveInput) => Promise<void>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    // Stacked action API
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (
      input: GitRunStackedActionInput,
    ) => Promise<GitRunStackedActionResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly { id: T; label: string }[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
}

