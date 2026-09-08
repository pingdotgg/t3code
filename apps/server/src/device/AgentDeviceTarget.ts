import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";

const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** A stable file per host lets forwarded endpoints change without retargeting other commands. */
export const agentDeviceConfigPath = (stateDir: string, hostId: string, path: Path.Path) =>
  path.join(stateDir, "device", "hosts", `${key(hostId)}.json`);

export const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  `t3-${key(JSON.stringify([threadId, hostId, deviceId]))}`;

export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: AgentDeviceEndpoint,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = `${JSON.stringify({ daemonBaseUrl: endpoint.baseUrl, daemonAuthToken: endpoint.token })}\n`;
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});
