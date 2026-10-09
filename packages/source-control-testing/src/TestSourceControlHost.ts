/**
 * A `SourceControlHost.SourceControlHost` for provider tests. Settings are fixed unless the test
 * supplies its own, and every process run goes to the test's `run`, which fails by default so an
 * unexpected CLI call is visible.
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
}

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
