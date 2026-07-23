import {
  type DesktopOpenRemoteZedInput,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const ZED_COMMANDS = ["zed", "zeditor"] as const;

export class DesktopZedCommandNotFoundError extends Schema.TaggedErrorClass<DesktopZedCommandNotFoundError>()(
  "DesktopZedCommandNotFoundError",
  {},
) {
  override get message(): string {
    return "Zed CLI not found.";
  }
}

export class DesktopZedLaunchError extends Schema.TaggedErrorClass<DesktopZedLaunchError>()(
  "DesktopZedLaunchError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open remote workspace in Zed with '${[this.command, ...this.args].join(" ")}'.`;
  }
}

function remoteAuthority(target: DesktopSshEnvironmentTarget): string {
  const host = target.alias.trim() || target.hostname.trim();
  const username = target.username?.trim();
  const port = target.port === null ? "" : `:${target.port}`;
  return `${username ? `${username}@` : ""}${host}${port}`;
}

function remoteUriPath(path: string): string {
  const normalized = path === "~" ? "/~" : path.startsWith("~/") ? `/~/${path.slice(2)}` : path;
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function remoteZedSshUri(input: DesktopOpenRemoteZedInput): string {
  return `ssh://${remoteAuthority(input.target)}${remoteUriPath(input.path)}`;
}

export class DesktopZedLauncher extends Context.Service<
  DesktopZedLauncher,
  {
    readonly openRemoteWorkspace: (
      input: DesktopOpenRemoteZedInput,
    ) => Effect.Effect<void, DesktopZedCommandNotFoundError | DesktopZedLaunchError>;
  }
>()("@t3tools/desktop/shell/DesktopZedLauncher") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const openRemoteWorkspace = Effect.fn("desktop.zed.openRemoteWorkspace")(function* (
    input: DesktopOpenRemoteZedInput,
  ) {
    let command = Option.none<string>();
    for (const candidate of ZED_COMMANDS) {
      if (
        yield* isCommandAvailable(candidate).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )
      ) {
        command = Option.some(candidate);
        break;
      }
    }
    if (Option.isNone(command)) {
      return yield* new DesktopZedCommandNotFoundError();
    }

    const args = ["-r", remoteZedSshUri(input)];
    const resolved = yield* resolveSpawnCommand(command.value, args).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const process = ChildProcess.make(resolved.command, resolved.args, {
      detached: true,
      shell: resolved.shell,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    yield* spawner.spawn(process).pipe(
      Effect.flatMap((handle) => handle.unref),
      Effect.asVoid,
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new DesktopZedLaunchError({
            command: resolved.command,
            args: resolved.args,
            cause,
          }),
      ),
    );
  });

  return DesktopZedLauncher.of({ openRemoteWorkspace });
});

export const layer = Layer.effect(DesktopZedLauncher, make);
