/**
 * A `SourceControlHost.SourceControlHost` for provider tests. Settings are fixed unless the test
 * supplies its own. Process runs and git operations go to what the test supplies; anything else
 * dies, so an unexpected CLI or git call is visible.
 *
 * @module source-control-testing/TestSourceControlHost
 */
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface TestSourceControlHostOptions {
  readonly settings?: ServerSettings;
  readonly process?: Partial<SourceControlHost.SourceControlHost["Service"]["process"]>;
  readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
}

type Git = SourceControlHost.SourceControlHost["Service"]["git"];

const unexpectedGit = (operation: string) => () =>
  Effect.die(`Unexpected git ${operation} in a test that supplied none.`);

const failingGit: Git = {
  remotes: unexpectedGit("remotes"),
  readConfigValue: unexpectedGit("readConfigValue"),
  resolvePrimaryRemoteName: unexpectedGit("resolvePrimaryRemoteName"),
  ensureRemote: unexpectedGit("ensureRemote"),
  listLocalBranchNames: unexpectedGit("listLocalBranchNames"),
  fetchRemoteBranch: unexpectedGit("fetchRemoteBranch"),
  fetchRemoteTrackingBranch: unexpectedGit("fetchRemoteTrackingBranch"),
  setBranchUpstream: unexpectedGit("setBranchUpstream"),
  switchRef: unexpectedGit("switchRef"),
};

export const layer = (
  options: TestSourceControlHostOptions = {},
): Layer.Layer<SourceControlHost.SourceControlHost> =>
  Layer.succeed(
    SourceControlHost.SourceControlHost,
    SourceControlHost.SourceControlHost.of({
      settings: { get: Effect.succeed(options.settings ?? DEFAULT_SERVER_SETTINGS) },
      process: {
        run:
          options.process?.run ??
          ((input) => Effect.die(`Unexpected ${input.command} run in ${input.operation}.`)),
      },
      git: { ...failingGit, ...options.git },
    }),
  );

/** A successful run's output, for tests that script CLI responses. */
export const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
