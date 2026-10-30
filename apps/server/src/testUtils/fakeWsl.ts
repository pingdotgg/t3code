import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// `wslpath` honours the distro's configurable automount root, so the fake maps drives under a temp dir.
export const makeFakeWslHost = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mountRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wsl-mnt-" });
  const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wsl-bin-" });
  const wslpath = path.join(binDir, "wslpath");
  yield* fileSystem
    .writeFileString(
      wslpath,
      [
        "#!/bin/sh",
        '[ "$1" = "-u" ] || exit 1',
        "p=$(printf '%s' \"$2\" | tr '\\\\' '/')",
        "drive=$(printf '%s' \"$p\" | cut -c1 | tr 'A-Z' 'a-z')",
        `printf '%s/%s%s\\n' '${mountRoot}' "$drive" "\${p#?:}"`,
        "",
      ].join("\n"),
    )
    .pipe(Effect.orDie);
  yield* fileSystem.chmod(wslpath, 0o755).pipe(Effect.orDie);
  const environment = {
    ...HostProcess.Environment.defaultValue(),
    PATH: `${binDir}:${HostProcess.Environment.defaultValue().PATH ?? ""}`,
    WSL_DISTRO_NAME: "Ubuntu",
  };
  const underWsl = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, environment),
    );
  return { mountRoot, underWsl };
});
