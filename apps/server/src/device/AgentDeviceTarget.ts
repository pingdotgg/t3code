import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as DeviceHost from "./DeviceHost.ts";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";

const encodeEndpoint = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ daemonBaseUrl: Schema.String, daemonAuthToken: Schema.String }),
  ),
);

const key = Effect.fn("AgentDeviceTarget.key")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.orDie);
  return Hex.encode(digest).slice(0, 24);
});

/** A thread-specific file keeps issued commands from sharing another thread's credential. */
export const agentDeviceConfigPath = (
  stateDir: string,
  hostId: string,
  path: Path.Path,
  target?: { readonly threadId: string; readonly deviceId: string },
) =>
  key(target === undefined ? hostId : JSON.stringify([hostId, target.deviceId])).pipe(
    Effect.map((hash) =>
      target === undefined
        ? path.join(stateDir, "device", "hosts", `${hash}.json`)
        : path.join(
            agentDeviceThreadConfigDirectory(stateDir, target.threadId, path),
            `${hash}.json`,
          ),
    ),
  );

export const agentDeviceThreadConfigDirectory = (
  stateDir: string,
  threadId: string,
  path: Path.Path,
) =>
  path.join(
    stateDir,
    "device",
    "agent-threads",
    encodeURIComponent(threadId).replaceAll(".", "%2E"),
  );

export const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  key(JSON.stringify([threadId, hostId, deviceId])).pipe(Effect.map((hash) => `t3-${hash}`));

export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: AgentDeviceEndpoint,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = yield* encodeEndpoint({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  });
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

/** Retire a raw host credential before this host can issue any scoped credentials. */
export const retireLegacyAgentDeviceConfig = Effect.fn("AgentDeviceTarget.retireLegacyConfig")(
  function* (stateDir: string, host: DeviceHost.DeviceHost["Service"]) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* agentDeviceConfigPath(stateDir, host.id, path);
    if (!(yield* fs.exists(file))) return host;
    const lock = yield* Semaphore.make(1);
    let pending = true;
    const retire = lock.withPermit(
      Effect.gen(function* () {
        if (!pending) return;
        yield* host.stopAgent;
        // Keep the file when the host is offline or cannot stop: it records the work still owed.
        yield* fs.remove(file, { force: true });
        pending = false;
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "DeviceHostError"
            ? cause
            : new DeviceHost.DeviceHostError({
                hostId: host.id,
                step: "invalidating recovered agent access",
                cause,
              }),
        ),
      ),
    );
    if (host.id === LOCAL_DEVICE_HOST_ID) {
      // Provider admission cannot race a local daemon that still accepts a recovered raw token.
      yield* retire;
    } else {
      // An offline SSH host must not hold up the environment's startup.
      yield* retire.pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Previous device access could not be retired; agent access will retry first.",
            { hostId: host.id },
          ),
        ),
        Effect.forkScoped,
      );
    }
    return {
      ...host,
      ensureAgentReady: (onPhase) => retire.pipe(Effect.andThen(host.ensureAgentReady(onPhase))),
    } satisfies DeviceHost.DeviceHost["Service"];
  },
);
