// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { ServerPrepareTriageError, type ServerPrepareTriageResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
} from "../cli/triagePrompt.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

export const describeServerProcess = Effect.fn("triage.describeServerProcess")(function* (
  serverRuntimeStatePath: string,
) {
  const state = yield* readPersistedServerRuntimeState(serverRuntimeStatePath);
  if (Option.isNone(state)) {
    return "not running (no server-runtime.json; the server may never have started here)";
  }
  const version =
    state.value.serverVersion === undefined
      ? "version not recorded"
      : `version ${state.value.serverVersion}`;
  if (!isProcessAlive(state.value.pid)) {
    return `not running (state file is stale: pid ${String(state.value.pid)} is dead; last origin ${state.value.origin}, ${version})`;
  }
  return `running (pid ${String(state.value.pid)}, ${state.value.origin}, ${version})`;
});

export const writeTriageSession = Effect.fn("triage.writeSession")(function* (input: {
  readonly baseDir: string;
  readonly paths: ServerConfig.ServerDerivedPaths;
  readonly cliVersion: string | null;
  readonly launchedAs: string;
  readonly startedWith: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { paths } = input;

  const now = yield* DateTime.now;
  const scratchDir = path.join(
    paths.stateDir,
    "triage",
    DateTime.formatIso(now).replaceAll(":", "-").replace(".", "-"),
  );
  yield* fs.makeDirectory(scratchDir, { recursive: true });

  const contextFilePath = path.join(scratchDir, "context.md");
  yield* fs.writeFileString(
    contextFilePath,
    buildTriageContext({
      generatedAt: DateTime.formatIso(now),
      generatedBy: input.startedWith,
      cliVersion: input.cliVersion,
      os: `${yield* HostProcess.Platform} ${yield* HostProcess.Architecture} (${NodeOS.release()})`,
      nodeVersion: process.version,
      launchedAs: input.launchedAs,
      server: yield* describeServerProcess(paths.serverRuntimeStatePath),
      paths: {
        stateDir: paths.stateDir,
        dbPath: paths.dbPath,
        settingsPath: paths.settingsPath,
        logsDir: paths.logsDir,
        serviceLogPath: path.join(paths.logsDir, BootService.BOOT_SERVICE_LOG_FILE),
        desktopBackendLogGlob: path.join(paths.logsDir, "server-child*.log*"),
        serverTracePath: paths.serverTracePath,
        providerEventLogPath: paths.providerEventLogPath,
        terminalLogsDir: paths.terminalLogsDir,
        providerStatusCacheDir: paths.providerStatusCacheDir,
        secretsDir: paths.secretsDir,
        sourceCacheDir: path.join(input.baseDir, "source"),
      },
    }),
  );

  // The agent is launched with a one-line pointer at this file: Windows `.cmd`
  // shims run through cmd.exe, which cannot carry the multiline playbook as an
  // argv string.
  const promptFilePath = path.join(scratchDir, "prompt.md");
  yield* fs.writeFileString(
    promptFilePath,
    buildTriageSeedPrompt(contextFilePath, input.startedWith),
  );

  return {
    scratchDir,
    contextFilePath,
    promptFilePath,
    launchPrompt: buildTriageLaunchPrompt(promptFilePath),
  };
});

export class Triage extends Context.Service<
  Triage,
  {
    readonly prepare: Effect.Effect<ServerPrepareTriageResult, ServerPrepareTriageError>;
  }
>()("t3/diagnostics/Triage") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const prepare = writeTriageSession({
    baseDir: config.baseDir,
    paths: config,
    cliVersion: null,
    launchedAs: `T3 Code server ${packageJson.version}, from the app's settings`,
    startedWith: "the Triage button in T3 Code's settings",
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.map(({ launchPrompt }) => ({ prompt: launchPrompt })),
    Effect.mapError((cause) => new ServerPrepareTriageError({ cause })),
  );

  return Triage.of({ prepare });
});

export const layer = Layer.effect(Triage, make);
