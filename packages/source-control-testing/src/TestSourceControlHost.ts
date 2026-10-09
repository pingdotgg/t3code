/**
 * A `SourceControlHost.SourceControlHost` for provider tests. Settings start from the defaults
 * or what the test supplies, and `TestSourceControlHostSettings` patches them mid-test the way a
 * client's settings write would. Process runs and git operations go to what the test supplies;
 * anything else dies, so an unexpected CLI or git call is visible.
 *
 * @module source-control-testing/TestSourceControlHost
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";

export interface TestSourceControlHostOptions {
  readonly settings?: ServerSettings;
  readonly process?: Partial<SourceControlHost.SourceControlHost["Service"]["process"]>;
  readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
}

/** Lets a test change the settings its `layer` reports. */
export class TestSourceControlHostSettings extends Context.Service<
  TestSourceControlHostSettings,
  { readonly update: (patch: ServerSettingsPatch) => Effect.Effect<void> }
>()("@t3tools/source-control-testing/TestSourceControlHost/TestSourceControlHostSettings") {}

type Git = SourceControlHost.SourceControlHost["Service"]["git"];

const unexpectedGit = (operation: string) => () =>
  Effect.die(`Unexpected git ${operation} in a test that supplied none.`);

const failingGit: Git = {
  execute: unexpectedGit("execute"),
  resolveCommit: unexpectedGit("resolveCommit"),
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
): Layer.Layer<SourceControlHost.SourceControlHost | TestSourceControlHostSettings> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
      const host = SourceControlHost.SourceControlHost.of({
        settings: { get: Ref.get(settings) },
        process: {
          run:
            options.process?.run ??
            ((input) => Effect.die(`Unexpected ${input.command} run in ${input.operation}.`)),
        },
        git: { ...failingGit, ...options.git },
      });
      return Context.make(SourceControlHost.SourceControlHost, host).pipe(
        Context.add(TestSourceControlHostSettings, {
          update: (patch) =>
            Ref.update(settings, (current) => applyServerSettingsPatch(current, patch)),
        }),
      );
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
