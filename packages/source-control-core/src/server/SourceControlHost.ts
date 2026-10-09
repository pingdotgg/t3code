/**
 * SourceControlHost — what a source control provider package may ask of the server it runs in.
 *
 * Providers run inside a T3 server but must not import it. The server provides this one
 * service; everything a provider needs from its environment (settings, the process runner)
 * goes through it, so a provider package depends only on `@t3tools/source-control-core` and
 * its own API and CLI code. HTTP, the filesystem, and paths come from Effect's platform
 * services directly.
 *
 * `git` is the subset of the server's git driver that checking out a change request needs; it
 * grows only when a provider needs another operation.
 *
 * @module source-control-core/server/SourceControlHost
 */
import type {
  GitCommandError,
  ServerSettings,
  ServerSettingsError,
  VcsError,
  VcsListRemotesResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
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

export type SourceControlGitOutput = Omit<
  SourceControlProcessOutput,
  "stdoutInvalidUtf8" | "stderrInvalidUtf8"
>;

export interface SourceControlGitRemoteBranch {
  readonly cwd: string;
  readonly remoteName: string;
  readonly remoteBranch: string;
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
    readonly git: {
      /** Runs `git -C cwd …args` through the server's git driver, with its limits and metrics. */
      readonly execute: (input: {
        readonly operation: string;
        readonly cwd: string;
        readonly args: ReadonlyArray<string>;
      }) => Effect.Effect<SourceControlGitOutput, GitCommandError>;
      readonly resolveCommit: (input: {
        readonly cwd: string;
        readonly revision: string;
      }) => Effect.Effect<{ readonly commitSha: string }, GitCommandError>;
      /**
       * Lists the remotes of the repository at `cwd`. The outer effect resolves the repository
       * and fails when the server cannot drive one there; the inner one lists its remotes.
       */
      readonly remotes: (
        cwd: string,
      ) => Effect.Effect<Effect.Effect<VcsListRemotesResult, VcsError>, VcsError>;
      readonly readConfigValue: (
        cwd: string,
        key: string,
      ) => Effect.Effect<string | null, GitCommandError>;
      readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
      /** Adds a remote for `url` unless one exists, and returns the name it is under. */
      readonly ensureRemote: (input: {
        readonly cwd: string;
        readonly preferredName: string;
        readonly url: string;
      }) => Effect.Effect<string, GitCommandError>;
      readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
      readonly fetchRemoteBranch: (
        input: SourceControlGitRemoteBranch & { readonly localBranch: string },
      ) => Effect.Effect<void, GitCommandError>;
      readonly fetchRemoteTrackingBranch: (
        input: SourceControlGitRemoteBranch,
      ) => Effect.Effect<void, GitCommandError>;
      readonly setBranchUpstream: (
        input: SourceControlGitRemoteBranch & { readonly branch: string },
      ) => Effect.Effect<void, GitCommandError>;
      readonly switchRef: (
        input: VcsSwitchRefInput,
      ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    };
  }
>()("@t3tools/source-control-core/server/SourceControlHost") {}
