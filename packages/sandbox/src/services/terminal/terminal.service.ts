import type { PtyHandle, PtyResult, Sandbox } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type { SandboxServiceShape } from "../sandbox";
import type {
  OpenSandboxPtySessionError,
  PtyInputError,
  PtyResizeError,
  PtyWaitError,
  StartPlaygroundSessionError,
  TerminalCleanupError,
} from "./terminal.errors";

export interface TerminalServiceOptions {
  sandboxService: SandboxServiceShape;
}

export interface TerminalServiceLayerOptions {
  autoStopInterval?: number;
}

export interface StartPlaygroundSessionOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  envs?: Record<string, string>;
  sandboxName?: string;
  onData?: (data: Uint8Array) => void | Promise<void>;
}

export interface OpenSandboxPtySessionOptions extends StartPlaygroundSessionOptions {
  sandboxId: string;
  deleteSandboxOnCleanup?: boolean;
}

export interface PlaygroundSession {
  sandbox: Sandbox;
  sandboxId: string;
  sessionId: string;
  pty: PtyHandle;
  cleanup: Effect.Effect<void, TerminalCleanupError>;
  sendInput: (input: string | Uint8Array) => Effect.Effect<void, PtyInputError>;
  resize: (cols: number, rows: number) => Effect.Effect<void, PtyResizeError>;
  wait: Effect.Effect<PtyResult, PtyWaitError>;
}

export interface TerminalServiceShape {
  readonly startPlaygroundSession: (
    options?: StartPlaygroundSessionOptions,
  ) => Effect.Effect<PlaygroundSession, StartPlaygroundSessionError>;
  readonly openSandboxPtySession: (
    options: OpenSandboxPtySessionOptions,
  ) => Effect.Effect<PlaygroundSession, OpenSandboxPtySessionError>;
}

export class TerminalService extends ServiceMap.Service<TerminalService, TerminalServiceShape>()(
  "@repo/sandbox/services/terminal/TerminalService",
) {}
