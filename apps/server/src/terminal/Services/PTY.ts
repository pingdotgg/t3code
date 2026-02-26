/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import { ServiceMap } from "effect";

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapterShape - Service API for spawning and controlling PTY processes.
 */
export interface PtyAdapterShape {
  /**
   * Spawn a PTY process for a terminal session.
   */
  spawn(input: PtySpawnInput): PtyProcess;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "terminal/PtyAdapter",
) {}
