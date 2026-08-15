import {
  DesktopAgentActivitySnapshot,
  DesktopAgentActivitySnapshotInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const DESKTOP_AGENT_ACTIVITY_SNAPSHOT_FILE = "agent-activity.json";
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DesktopAgentActivitySnapshot));

function opaqueActivityId(sourceId: string): string {
  return `activity-${NodeCrypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}

export const publishAgentActivitySnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PUBLISH_AGENT_ACTIVITY_SNAPSHOT_CHANNEL,
  payload: DesktopAgentActivitySnapshotInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.agentActivity.publishSnapshot")(function* (snapshot) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetPath = path.join(environment.stateDir, DESKTOP_AGENT_ACTIVITY_SNAPSHOT_FILE);
    const encoded = yield* encodeSnapshot({
      schemaVersion: snapshot.schemaVersion,
      generatedAt: snapshot.generatedAt,
      activities: snapshot.activities.map(({ sourceId, label, phase, updatedAt }) => ({
        id: opaqueActivityId(sourceId),
        label,
        phase,
        updatedAt,
      })),
    });

    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    const temporaryPath = yield* fileSystem.makeTempFile({
      directory: environment.stateDir,
      prefix: ".agent-activity.",
      suffix: ".tmp",
    });
    yield* fileSystem.writeFileString(temporaryPath, `${encoded}\n`);
    yield* fileSystem
      .rename(temporaryPath, targetPath)
      .pipe(Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.orDie)));
  }),
});

export const clearAgentActivitySnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_AGENT_ACTIVITY_SNAPSHOT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.agentActivity.clearSnapshot")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.remove(
      path.join(environment.stateDir, DESKTOP_AGENT_ACTIVITY_SNAPSHOT_FILE),
      { force: true },
    );
  }),
});
