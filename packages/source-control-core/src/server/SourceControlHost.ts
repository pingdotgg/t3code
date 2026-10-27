import type {
  GitCommandError,
  ServerSettings,
  ServerSettingsError,
  VcsError,
  VcsListRemotesResult,
  VcsProcessExitFailureKind,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly appendTruncationMarker?: boolean;
  /**
   * Reads a failure the generic rules cannot, such as a host CLI's sign-in hint, from its stderr.
   * Null leaves it to them.
   */
  readonly classifyFailure?: (stderr: string) => VcsProcessExitFailureKind | null;
  /** The error's detail when the command reports something it was asked for as missing. */
  readonly notFoundDetail?: string;
  /**
   * Runs sharing a key run at most `limit` at a time, for a host that throttles bursts of its CLI.
   * The first run of a key fixes its limit.
   */
  readonly concurrency?: { readonly key: string; readonly limit: number };
}

export interface SourceControlProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
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
      /** Read fresh on each call to pick up credential changes. */
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
    };
    readonly process: {
      readonly run: (
        input: SourceControlProcessInput,
      ) => Effect.Effect<SourceControlProcessOutput, VcsError>;
    };
    readonly git: {
      readonly execute: (input: {
        readonly operation: string;
        readonly cwd: string;
        readonly args: ReadonlyArray<string>;
        readonly maxOutputBytes?: number;
        readonly appendTruncationMarker?: boolean;
      }) => Effect.Effect<SourceControlGitOutput, GitCommandError>;
      readonly resolveCommit: (input: {
        readonly cwd: string;
        readonly revision: string;
      }) => Effect.Effect<{ readonly commitSha: string }, GitCommandError>;
      /** The outer effect resolves the repository; the inner effect lists its remotes. */
      readonly remotes: (
        cwd: string,
      ) => Effect.Effect<Effect.Effect<VcsListRemotesResult, VcsError>, VcsError>;
      readonly readConfigValue: (
        cwd: string,
        key: string,
      ) => Effect.Effect<string | null, GitCommandError>;
      readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
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
      /**
       * Writes to .git/config, which every worktree shares, go through these rather than
       * `execute`: the host serializes them per repository.
       */
      readonly createBranch: (input: {
        readonly cwd: string;
        readonly branch: string;
        readonly startPoint: string;
      }) => Effect.Effect<void, GitCommandError>;
      readonly writeConfigValue: (input: {
        readonly cwd: string;
        readonly key: string;
        readonly value: string;
      }) => Effect.Effect<void, GitCommandError>;
      readonly switchRef: (
        input: VcsSwitchRefInput,
      ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    };
  }
>()("@t3tools/source-control-core/server/SourceControlHost") {}
