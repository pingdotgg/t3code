/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * PtySpawnError - Error type for PTY spawn failures.
 */
export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

/**
 * A spawn failure whose real culprit is node-pty's `spawn-helper` missing its
 * exec bit. It fails identically for every shell, so the terminal manager must
 * not bury it under the shell-candidate fallback.
 */
export class SpawnHelperNotExecutableError extends Schema.TaggedErrorClass<SpawnHelperNotExecutableError>()(
  "SpawnHelperNotExecutableError",
  {
    helperPath: Schema.String,
    // Always the originating spawn failure, so the error chain is never lost.
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `node-pty's spawn-helper at ${this.helperPath} is not executable, so every shell fails with "posix_spawnp failed". Fix it with: chmod +x "${this.helperPath}"`;
  }
}

const isSpawnHelperNotExecutableError = Schema.is(SpawnHelperNotExecutableError);

/** Walks the cause chain so wrapping a diagnosed failure never hides the tag. */
export const hasSpawnHelperNotExecutableCause = (error: unknown): boolean => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (isSpawnHelperNotExecutableError(current)) return true;
    if (typeof current !== "object") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

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
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    /**
     * Spawn a PTY process for a terminal session.
     */
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("t3/terminal/PtyAdapter") {}
