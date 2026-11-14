import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const SESSION_ADDRESS_PREFIX = "DBUS_SESSION_BUS_ADDRESS=";

/**
 * gh reads its keyring through godbus, which autolaunches a `dbus-launch` daemon that outlives gh
 * when no session bus is configured or discoverable. On WSL and headless hosts each lookup leaks one
 * until inotify runs out, so only then turn the bus off and let the keyring read fail.
 */
export const makeGhProcess = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;

  const noBusToDiscover = Effect.gen(function* () {
    if (platform === "darwin" || userId === undefined) return false;
    const runtimeDir = `/run/user/${userId}`;
    // godbus takes the bus socket if stat finds anything there, but uses `dbus-session` only
    // when it reads as `DBUS_SESSION_BUS_ADDRESS=<address>`; otherwise it still autolaunches.
    if (yield* fileSystem.exists(`${runtimeDir}/bus`).pipe(Effect.orElseSucceed(() => true))) {
      return false;
    }
    const session = yield* fileSystem
      .readFileString(`${runtimeDir}/dbus-session`)
      .pipe(Effect.orElseSucceed(() => ""));
    if (!session.startsWith(SESSION_ADDRESS_PREFIX)) return true;
    // Trailing line breaks are not an address; a loop keeps this linear on a malformed file.
    let end = session.length;
    while (
      end > SESSION_ADDRESS_PREFIX.length &&
      (session[end - 1] === "\n" || session[end - 1] === "\r")
    ) {
      end--;
    }
    return end === SESSION_ADDRESS_PREFIX.length;
  });

  return {
    run: (input) => {
      // The spawn's own env extends the host's, so its address is the one gh will see.
      const address =
        input.env !== undefined && "DBUS_SESSION_BUS_ADDRESS" in input.env
          ? input.env.DBUS_SESSION_BUS_ADDRESS
          : environment.DBUS_SESSION_BUS_ADDRESS;
      if (address && address !== "autolaunch:") return process.run(input);
      return noBusToDiscover.pipe(
        Effect.flatMap((missing) =>
          process.run(
            missing
              ? { ...input, env: { ...input.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" } }
              : input,
          ),
        ),
      );
    },
  } satisfies SourceControlHost.SourceControlHost["Service"]["process"];
});
