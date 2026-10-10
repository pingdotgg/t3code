import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class CloudCliError extends Schema.TaggedError<CloudCliError>()("CloudCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface CloudCliRequest {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Written to the child's stdin, which then closes. */
  readonly stdin?: string;
  /** Sees each stderr line as it arrives, for progress a command prints before it exits. */
  readonly onStderrLine?: (line: string) => Effect.Effect<void>;
}

export interface CloudCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs one provider CLI command to completion. Interrupting it kills the child. */
export type CloudCli = (request: CloudCliRequest) => Effect.Effect<CloudCliResult, CloudCliError>;

const encoder = new TextEncoder();

/** Binds a `CloudCli` to one binary and environment. */
export const makeCloudCli = (
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<CloudCli, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return (request) =>
      Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(binaryPath, request.args, { env });
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env,
            cwd: request.cwd,
            shell: spawnCommand.shell,
            stdin:
              request.stdin === undefined ? "ignore" : Stream.make(encoder.encode(request.stdin)),
          }),
        );
        const stderrLines: Array<string> = [];
        const [stdout, , code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => {
                stderrLines.push(line);
                return request.onStderrLine?.(line) ?? Effect.void;
              }),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr: stderrLines.join("\n"), code };
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            // The raw failure stays in `cause`; the thread shows only this.
            new CloudCliError({
              detail: `Could not run ${binaryPath}. Check its path on this T3 server host.`,
              cause,
            }),
        ),
      );
  });

/** The last non-empty line of CLI output, which is where these CLIs print their error. */
export const lastLine = (output: string): string | undefined =>
  output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
