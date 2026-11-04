import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { PersistedServerRuntimeState } from "@t3tools/contracts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import type { DesktopBackendConfiguration } from "./DesktopBackendConfiguration.ts";
import type { DesktopBackendInstance, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-auto-attach");

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PROBE_TIMEOUT = Duration.millis(1500);
const PROBE_RETRY_INTERVAL = Duration.millis(500);
const MAX_PROBE_RETRIES = 3;

const isProcessAlive = (pid: number): boolean => {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    );
  }
};

const decodePersistedState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const probeServerReady = Effect.fn("desktop.autoAttach.probeServerReady")(function* (origin: URL) {
  const client = yield* HttpClient.HttpClient;
  const probeUrl = new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin).toString();
  const request = HttpClientRequest.get(probeUrl);
  const response = yield* client.execute(request).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return response;
});

export const tryAutoAttachToRunningServer = Effect.fn(
  "desktop.autoAttach.tryAutoAttachToRunningServer",
)(function* (input: {
  readonly stateDir: string;
  readonly backendCwd: string;
  readonly primary: DesktopBackendInstance;
  readonly configuration: DesktopBackendConfiguration["Service"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeStatePath = path.join(input.stateDir, "server-runtime.json");

  const fileExists = yield* fs.exists(runtimeStatePath).pipe(Effect.orElseSucceed(() => false));
  if (!fileExists) {
    yield* logInfo("No server-runtime.json found; auto-attach skipped", { runtimeStatePath });
    return false;
  }

  const rawContent = yield* fs.readFileString(runtimeStatePath).pipe(Effect.option);
  if (Option.isNone(rawContent)) {
    yield* logWarning("Failed to read server-runtime.json; auto-attach skipped", {
      runtimeStatePath,
    });
    return false;
  }

  const parsedOption = decodePersistedState(rawContent.value);
  if (Option.isNone(parsedOption)) {
    yield* logWarning("Failed to parse server-runtime.json; auto-attach skipped", {
      runtimeStatePath,
    });
    return false;
  }

  const state = parsedOption.value;
  const origin = yield* Effect.try(() => new URL(state.origin)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (origin === null) {
    yield* logWarning("server-runtime.json has an invalid origin; auto-attach skipped", {
      origin: state.origin,
    });
    return false;
  }

  if (state.desktopBootstrapSecret === undefined && state.desktopBootstrapToken === undefined) {
    yield* logWarning(
      "server-runtime.json has no desktop bootstrap credentials; auto-attach skipped",
      { runtimeStatePath, pid: state.pid },
    );
    return false;
  }

  if (!isProcessAlive(state.pid)) {
    yield* logWarning("Server recorded in server-runtime.json is dead; auto-attach skipped", {
      pid: state.pid,
      origin: state.origin,
    });
    return false;
  }

  let ready = yield* probeServerReady(origin);
  let retryCount = 0;
  while (!ready && retryCount < MAX_PROBE_RETRIES && isProcessAlive(state.pid)) {
    retryCount++;
    yield* logInfo("External server alive but not yet responsive; waiting before retry", {
      attempt: retryCount,
      origin: state.origin,
    });
    yield* Effect.sleep(PROBE_RETRY_INTERVAL);
    ready = yield* probeServerReady(origin);
  }

  if (!ready) {
    yield* logWarning("External server failed readiness probes; auto-attach failed", {
      origin: state.origin,
      pid: state.pid,
    });
    return false;
  }

  if (state.desktopBootstrapSecret) {
    yield* input.configuration.setBootstrapSecret(state.desktopBootstrapSecret);
  }

  const attachedConfig: DesktopBackendStartConfig = {
    executablePath: "",
    entryPath: "",
    cwd: input.backendCwd,
    args: [],
    env: {},
    extendEnv: false,
    httpBaseUrl: origin,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: state.port,
      host: state.host ?? "127.0.0.1",
      desktopBootstrapToken: state.desktopBootstrapToken ?? "",
      ...(state.desktopBootstrapSecret
        ? { desktopBootstrapSecret: state.desktopBootstrapSecret }
        : {}),
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "fd3",
    captureOutput: false,
    preflightFailure: Option.none(),
  };

  yield* input.primary.attachExternal(attachedConfig, Option.some(state.pid));
  yield* logInfo("Successfully auto-attached to running external server", {
    origin: state.origin,
    pid: state.pid,
  });
  return true;
});
