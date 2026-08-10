import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DesktopAgentActivitySnapshot,
  type DesktopAgentActivitySnapshotInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  clearAgentActivitySnapshot,
  DESKTOP_AGENT_ACTIVITY_SNAPSHOT_FILE,
  publishAgentActivitySnapshot,
} from "./agentActivity.ts";

const snapshot: DesktopAgentActivitySnapshotInput = {
  schemaVersion: 1,
  generatedAt: "2026-08-10T20:00:00.000Z",
  activities: [
    {
      sourceId: "remote-env:thread-1",
      label: "Build Mac · Ship the bridge",
      phase: "running",
      updatedAt: "2026-08-10T20:00:00.000Z",
    },
  ],
};

const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(DesktopAgentActivitySnapshot));

describe("desktop agent activity IPC", () => {
  it.effect("atomically publishes the credential-free snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-agent-activity-test-",
      });
      const environmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      );

      yield* publishAgentActivitySnapshot.handler(snapshot).pipe(Effect.provide(environmentLayer));
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(environmentLayer),
      );
      const targetPath = environment.path.join(
        environment.stateDir,
        DESKTOP_AGENT_ACTIVITY_SNAPSHOT_FILE,
      );
      const persisted = yield* fileSystem.readFileString(targetPath);

      assert.deepEqual(yield* decodeSnapshot(persisted), {
        schemaVersion: 1,
        generatedAt: snapshot.generatedAt,
        activities: [
          {
            id: "activity-1",
            label: "Build Mac · Ship the bridge",
            phase: "running",
            updatedAt: "2026-08-10T20:00:00.000Z",
          },
        ],
      });
      assert.notInclude(persisted, "remote-env");
      assert.notInclude(persisted, "thread-1");

      yield* clearAgentActivitySnapshot.handler(undefined).pipe(Effect.provide(environmentLayer));
      assert.isFalse(yield* fileSystem.exists(targetPath));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
