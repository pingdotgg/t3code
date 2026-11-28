import type * as ChildProcess from "effect/process/ChildProcess"
import type * as NodeChildProcess from "node:child_process"
import type { Readable, Writable } from "node:stream"

/**
 * The parts of a Node.js `ChildProcess` the spawner uses, so that a command
 * launched by a proxy process can stand in for a direct child. Besides the
 * `ChildProcess` events, it may emit `"lost"` with an `Error` when its exit
 * status can no longer be observed.
 *
 * @internal
 */
export interface SpawnedProcess {
  readonly pid?: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdio: ReadonlyArray<Readable | Writable | null | undefined>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  /**
   * Whether the exit status can no longer be observed. The process may have
   * exited and its PID been reused, so it must not be signalled automatically.
   */
  readonly lost?: boolean | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  ref(): void
  unref(): void
  on(event: string, listener: (...args: Array<any>) => void): this
  removeListener(event: string, listener: (...args: Array<any>) => void): this
}

/** @internal */
export type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions
) => SpawnedProcess

export const buildSpawnOptions = (
  options: ChildProcess.CommandOptions,
  base: Pick<NodeChildProcess.SpawnOptions, "cwd" | "env" | "stdio">,
  platform: NodeJS.Platform
): NodeChildProcess.SpawnOptions => {
  const detached = options.detached ?? platform !== "win32"
  return {
    ...base,
    detached,
    shell: options.shell,
    windowsHide: options.windowsHide ?? !detached
  }
}
