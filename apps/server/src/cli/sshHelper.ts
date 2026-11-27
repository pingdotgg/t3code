// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as DesktopUpdateMarker from "../desktopUpdate/DesktopUpdateMarker.ts";
import { serviceLauncherIsServing, stateDirOwned } from "../serviceLauncher.ts";
import { pickSshPort, readSshRuntimePort, waitForSshServer } from "./sshProbe.ts";

const pickPort = Command.make("pick-port", {
  portFile: Argument.String("port-file"),
  defaultPort: Argument.Int("default-port"),
  scanWindow: Argument.Int("scan-window"),
}).pipe(
  Command.withHandler(({ portFile, defaultPort, scanWindow }) =>
    Effect.promise(async () => {
      const port = await pickSshPort(portFile, defaultPort, scanWindow);
      if (port === undefined) process.exitCode = 1;
      else process.stdout.write(String(port));
    }),
  ),
);

const waitReady = Command.make("wait-ready", {
  port: Argument.Int("port"),
  timeoutMs: Argument.Int("timeout-ms"),
  probeTimeoutMs: Argument.Int("probe-timeout-ms"),
}).pipe(
  Command.withHandler(({ port, timeoutMs, probeTimeoutMs }) =>
    Effect.promise(async () => {
      process.exitCode = await waitForSshServer(port, timeoutMs, probeTimeoutMs);
    }),
  ),
);

/** Prints `<pid> <port>` for a live default-home server, or exits 1. */
const runtimePort = Command.make("runtime-port", {
  runtimeFile: Argument.String("runtime-file"),
}).pipe(
  Command.withHandler(({ runtimeFile }) =>
    Effect.sync(() => {
      const result = readSshRuntimePort(runtimeFile);
      if (result === undefined) process.exitCode = 1;
      else process.stdout.write(result);
    }),
  ),
);

const decodeRunningServer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, serverVersion: Schema.String })),
);

/** True when the runtime file names `pid` and a server version at or above `ownVersion`. */
export const keepsRunningServer = (runtimeJson: string, pid: number, ownVersion: string) =>
  Option.match(decodeRunningServer(runtimeJson), {
    onNone: () => false,
    onSome: (runtime) =>
      runtime.pid === pid &&
      isExactServiceVersion(runtime.serverVersion) &&
      compareExactServiceVersions(runtime.serverVersion, ownVersion) >= 0,
  });

/** Exits 0 when the managed server `pid` runs this version or a newer one, else 1. */
const keepServer = Command.make("keep-server", {
  runtimeFile: Argument.String("runtime-file"),
  pid: Argument.Int("pid"),
}).pipe(
  Command.withHandler(({ runtimeFile, pid }) =>
    Effect.sync(() => {
      const runtimeJson = NodeFS.existsSync(runtimeFile)
        ? NodeFS.readFileSync(runtimeFile, "utf8")
        : "";
      if (!keepsRunningServer(runtimeJson, pid, packageJson.version)) process.exitCode = 1;
    }),
  ),
);

const updateRemaining = Command.make("update-remaining", {
  markerFile: Argument.String("marker-file"),
}).pipe(
  Command.withHandler(({ markerFile }) =>
    DesktopUpdateMarker.DesktopUpdateMarker.use((marker) => marker.remainingWait(markerFile)).pipe(
      Effect.flatMap((remaining) =>
        Effect.sync(() => {
          process.stdout.write(Option.match(remaining, { onNone: () => "", onSome: String }));
        }),
      ),
    ),
  ),
  Command.provide(DesktopUpdateMarker.layer),
);

/** Exits 0 while a server holds this home or a boot service is about to start one. */
const homeOwned = Command.make("home-owned", {
  baseDir: Argument.String("base-dir"),
}).pipe(
  Command.withHandler(({ baseDir }) =>
    Effect.promise(async () => {
      if (!((await serviceLauncherIsServing(baseDir)) || (await stateDirOwned(baseDir)))) {
        process.exitCode = 1;
      }
    }),
  ),
);

export const sshHelperCommand = Command.make("__ssh-helper").pipe(
  Command.unlisted,
  Command.withSubcommands([
    pickPort,
    waitReady,
    runtimePort,
    updateRemaining,
    homeOwned,
    keepServer,
  ]),
);
