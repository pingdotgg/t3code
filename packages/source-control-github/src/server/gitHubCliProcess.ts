import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const SESSION_ADDRESS_PREFIX = "DBUS_SESSION_BUS_ADDRESS=";

/**
 * Runs `gh` without letting it autolaunch a D-Bus session bus.
 *
 * gh reads its keyring through godbus. With no bus address and no bus under `/run/user/<uid>`,
 * godbus runs `dbus-launch`, whose daemon outlives gh. On hosts without a user session (WSL,
 * headless servers) every keyring read then leaks a daemon until inotify instances run out.
 * Only in that case, turn the bus off so the keyring read fails instead; a configured or
 * discoverable bus is left alone, matching godbus's own lookup.
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
    const sessionAddress = session.startsWith(SESSION_ADDRESS_PREFIX)
      ? session.slice(SESSION_ADDRESS_PREFIX.length).replace(/[\r\n]+$/u, "")
      : "";
    return sessionAddress === "";
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
