import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "./DeviceService.ts";
import { agentDeviceThreadConfigDirectory } from "./AgentDeviceTarget.ts";

/** Keep deletion cleanup above the device/provider service dependency graph. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const devices = yield* DeviceService.DeviceService;
    const events = yield* EventSink.EventSinkV2;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const retire = Effect.fn("DeviceAgentLifecycle.retire")(
      (threadId: ThreadId) => devices.retireThreadAgentAccess(threadId),
      Effect.catch((cause) => Effect.logError("Device access deletion cleanup failed", { cause })),
    );
    const removeProjectOverride = Effect.fn("DeviceAgentLifecycle.removeProjectOverride")(
      (projectId: ProjectId) =>
        settings
          .updateSettings({ projectSettingsOverrides: { [projectId]: null } })
          .pipe(Effect.asVoid),
      Effect.catch((cause) =>
        Effect.logError("Deleted project device access cleanup failed", { cause }),
      ),
    );
    // Capture the committed cursor first: deletion during the sweep is replayed.
    const afterSequence = yield* events.latestSequence();
    const directory = path.join(config.stateDir, "device", "agent-threads");
    if (yield* fs.exists(directory)) {
      for (const name of yield* fs.readDirectory(directory)) {
        const decoded = yield* Effect.try(() => decodeURIComponent(name)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (decoded === null) continue;
        // Only paths produced by this scoped namespace belong to us.
        if (
          agentDeviceThreadConfigDirectory(config.stateDir, decoded, path) !==
          path.join(directory, name)
        )
          continue;
        const threadId = ThreadId.make(decoded);
        const thread = yield* threads.getThreadShell(threadId);
        if (thread === null || thread.deletedAt !== null) yield* retire(threadId);
      }
    }
    // Positive grants left by a deletion before startup must not retain a helper.
    for (const [id, override] of Object.entries(
      (yield* settings.getSettings).projectSettingsOverrides,
    )) {
      if (override.enableAgentDeviceAccess !== true) continue;
      const projectId = ProjectId.make(id);
      const project = yield* projects.get(projectId, { includeDeleted: true });
      if (Option.isNone(project) || project.value.deletedAt !== null)
        yield* removeProjectOverride(projectId);
    }
    yield* events.stream({ afterSequence, eventType: "thread.deleted" }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "thread.deleted" ? retire(stored.event.payload.id) : Effect.void,
      ),
      Effect.catch((cause) => Effect.logError("Device access deletion cleanup failed", { cause })),
      Effect.forkScoped,
    );
  }),
);
