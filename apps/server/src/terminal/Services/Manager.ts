import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { PtyProcess } from "./PTY";
import { Effect, ServiceMap } from "effect";

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalManagerShape {
  readonly open: (input: TerminalOpenInput) => Effect.Effect<TerminalSessionSnapshot, unknown>;
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, unknown>;
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, unknown>;
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, unknown>;
  readonly restart: (input: TerminalOpenInput) => Effect.Effect<TerminalSessionSnapshot, unknown>;
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, unknown>;
  readonly subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>;
  readonly dispose: () => Effect.Effect<void>;
}

export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "terminal/TerminalManager",
) {}
