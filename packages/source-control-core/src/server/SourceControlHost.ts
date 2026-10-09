/**
 * SourceControlHost — what a source control provider package may ask of the server it runs in.
 *
 * Providers run inside a T3 server but must not import it. The server provides this one
 * service; everything a provider needs from its environment (settings, the process runner)
 * goes through it, so a provider package depends only on `@t3tools/source-control-core` and
 * its own API and CLI code. HTTP, the filesystem, and paths come from Effect's platform
 * services directly.
 *
 * @module source-control-core/server/SourceControlHost
 */
import type { ServerSettings, ServerSettingsError, VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** One CLI invocation. The server bounds concurrency, output, and time for every run. */
export interface SourceControlProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** What happens past `maxOutputBytes`: fail the run, or keep the first bytes. */
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly appendTruncationMarker?: boolean;
}

export interface SourceControlProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Present on real process output; optional so narrow test doubles remain lightweight. */
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class SourceControlHost extends Context.Service<
  SourceControlHost,
  {
    readonly settings: {
      /** Read fresh on each call, so a credential saved in Settings applies without a restart. */
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
    };
    readonly process: {
      readonly run: (
        input: SourceControlProcessInput,
      ) => Effect.Effect<SourceControlProcessOutput, VcsError>;
    };
  }
>()("@t3tools/source-control-core/server/SourceControlHost") {}
