import type { AgentConfig, AgentExit, OutputChunk } from "./agent";
import type {
  ProviderEvent,
  ProviderInterruptTurnInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "./provider";
import type { TerminalCommandInput, TerminalCommandResult } from "./terminal";
import type { NewTodoInput, Todo } from "./todo";

export const IPC_CHANNELS = {
  todosList: "todos:list",
  todosAdd: "todos:add",
  todosToggle: "todos:toggle",
  todosRemove: "todos:remove",
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
  providerEvent: "provider:event",
} as const;

export interface NativeApi {
  todos: {
    list: () => Promise<Todo[]>;
    add: (input: NewTodoInput) => Promise<Todo[]>;
    toggle: (id: string) => Promise<Todo[]>;
    remove: (id: string) => Promise<Todo[]>;
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
    startSession: (
      input: ProviderSessionStartInput,
    ) => Promise<ProviderSession>;
    sendTurn: (
      input: ProviderSendTurnInput,
    ) => Promise<ProviderTurnStartResult>;
    interruptTurn: (input: ProviderInterruptTurnInput) => Promise<void>;
    stopSession: (input: ProviderStopSessionInput) => Promise<void>;
    listSessions: () => Promise<ProviderSession[]>;
    onEvent: (callback: (event: ProviderEvent) => void) => () => void;
  };
}
