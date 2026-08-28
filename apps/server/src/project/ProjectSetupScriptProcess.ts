import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export interface ProjectSetupScriptSpawnInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface ProjectSetupScriptProcessHandle {
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exitCode: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

export class ProjectSetupScriptSpawnError extends Schema.TaggedErrorClass<ProjectSetupScriptSpawnError>()(
  "ProjectSetupScriptSpawnError",
  {
    command: Schema.String,
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn project setup script '${this.command}' in '${this.cwd}'.`;
  }
}

export class ProjectSetupScriptProcess extends Context.Service<
  ProjectSetupScriptProcess,
  {
    readonly spawn: (
      input: ProjectSetupScriptSpawnInput,
    ) => Effect.Effect<ProjectSetupScriptProcessHandle, ProjectSetupScriptSpawnError, Scope.Scope>;
  }
>()("t3/project/ProjectSetupScriptProcess") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;

  const spawn: ProjectSetupScriptProcess["Service"]["spawn"] = Effect.fn(
    "ProjectSetupScriptProcess.spawn",
  )(function* (input) {
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.command, [], {
          cwd: input.cwd,
          env: input.env,
          extendEnv: true,
          shell: true,
          stdin: "ignore",
          detached: hostPlatform !== "win32",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptSpawnError({
              command: input.command,
              cwd: input.cwd,
              cause,
            }),
        ),
      );

    const killProcessGroup = (signal: NodeJS.Signals) =>
      hostPlatform === "win32"
        ? child.kill({ killSignal: signal }).pipe(Effect.asVoid)
        : Effect.sync(() => {
            try {
              process.kill(-Number(child.pid), signal);
            } catch {
              // The shell or its children may already have exited.
            }
          });

    const handle: ProjectSetupScriptProcessHandle = {
      stdout: child.stdout.pipe(Stream.catchCause(() => Stream.empty)),
      stderr: child.stderr.pipe(Stream.catchCause(() => Stream.empty)),
      exitCode: child.exitCode.pipe(
        Effect.map((code) => Number(code)),
        Effect.orElseSucceed(() => 1),
      ),
      kill: killProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killProcessGroup("SIGKILL")),
        Effect.ignore,
      ),
    };
    return handle;
  });

  return ProjectSetupScriptProcess.of({ spawn });
});

export const layer = Layer.effect(ProjectSetupScriptProcess, make);
