import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  type ServerSettings,
  type ServerSettingsPatch,
  VcsProcessExitError,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface TestSourceControlHostOptions {
  readonly settings?: ServerSettings;
  readonly process?: Partial<SourceControlHost.SourceControlHost["Service"]["process"]>;
  readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
}

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

const TRUNCATION_MARKER = "\n\n[truncated]";
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number, marker: string) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const bytes = Buffer.concat(Array.from(chunks));
      const truncated = bytes.byteLength > maxBytes;
      const text = bytes.subarray(0, maxBytes).toString("utf8");
      return { text: truncated ? `${text}${marker}` : text, truncated };
    }),
  );

/**
 * Runs commands for real, the way the server's host does in the parts a forge reads: output is
 * capped and marked, and a non-zero exit fails unless allowed. It has none of the server's
 * timeouts, concurrency limits, generic failure classification, or retries.
 */
const runForReal = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: SourceControlHost.SourceControlProcessInput,
): Effect.Effect<
  SourceControlHost.SourceControlProcessOutput,
  VcsProcessSpawnError | VcsProcessExitError
> => {
  const context = {
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    argumentCount: input.args.length,
  };
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const marker = input.appendTruncationMarker ? TRUNCATION_MARKER : "";
  return Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, input.args, {
        cwd: input.spawnCwd ?? input.cwd,
        ...(input.env === undefined ? {} : { env: input.env, extendEnv: true }),
      }),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        collectText(
          input.onStdoutChunk === undefined
            ? child.stdout
            : child.stdout.pipe(
                Stream.tap((chunk) => Effect.sync(() => input.onStdoutChunk?.(chunk))),
              ),
          maxBytes,
          marker,
        ),
        collectText(child.stderr, maxBytes, marker),
        input.stdin === undefined
          ? Effect.void
          : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin),
      ],
      { concurrency: "unbounded" },
    );
    const exitCode = yield* child.exitCode;
    if (exitCode !== 0 && !input.allowNonZeroExit) {
      return yield* VcsProcessExitError.fromProcessExit(
        context,
        { exitCode, stderr: stderr.text, stderrTruncated: stderr.truncated },
        input.classifyFailure?.(stderr.text) ?? "command-failed",
        input.notFoundDetail === undefined ? undefined : { notFoundDetail: input.notFoundDetail },
      );
    }
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new VcsProcessSpawnError({ ...context, cause })),
    }),
  );
};

/**
 * `layer` whose `process.run` and `git.execute` spawn real processes, for a forge test that needs
 * a real repository. Every other git operation still dies unless supplied.
 */
export const layerWithRealGit = (
  options: TestSourceControlHostOptions = {},
): Layer.Layer<SourceControlHost.SourceControlHost | TestSourceControlHostSettings> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = (input: SourceControlHost.SourceControlProcessInput) =>
        runForReal(spawner, input);
      return layer({
        ...options,
        process: { run, ...options.process },
        git: {
          execute: (input) =>
            run({ ...input, command: "git" }).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    argumentCount: input.args.length,
                    ...(cause._tag === "VcsProcessExitError" ? { exitCode: cause.exitCode } : {}),
                    detail: cause.message,
                    cause,
                  }),
              ),
            ),
          ...options.git,
        },
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
