import type { AgentConfig, AgentExit, OutputChunk } from "./agent";
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
import type { TerminalCommandInput, TerminalCommandResult } from "./terminal";
import type { NewTodoInput, Todo } from "./todo";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export type EditorId = (typeof EDITORS)[number]["id"];

export const IPC_CHANNELS = {
  todosList: "todos:list",
  todosAdd: "todos:add",
  todosToggle: "todos:toggle",
  todosRemove: "todos:remove",
  dialogPickFolder: "dialog:pick-folder",
  terminalRun: "terminal:run",
  agentSpawn: "agent:spawn",
  agentKill: "agent:kill",
  agentWrite: "agent:write",
  agentOutput: "agent:output",
  agentExit: "agent:exit",
  providerSessionStart: "provider:session:start",
  providerTurnStart: "provider:turn:start",
  providerTurnInterrupt: "provider:turn:interrupt",
  providerSessionStop: "provider:session:stop",
  providerSessionList: "provider:session:list",
  providerRequestRespond: "provider:request:respond",
  providerEvent: "provider:event",
  shellOpenInEditor: "shell:open-in-editor",
} as const;

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
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
  };
}
