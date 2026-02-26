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

export interface PtyAdapterShape {
  spawn(input: PtySpawnInput): PtyProcess;
}

export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "terminal/PtyAdapter",
) {}
