import {
  CommandId,
  DEFAULT_HOME_SETTINGS,
  HOME_THREAD_ID_PREFIX,
  HomeError,
  type HomeEnableInput,
  type HomeSettings,
  type HomeThreadResult,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as BotService from "../bots/BotService.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { homeFolderRoot } from "./homeFolder.ts";

export class HomeService extends Context.Service<
  HomeService,
  {
    readonly read: Effect.Effect<HomeSettings, HomeError>;
    /** Starts Home, or returns the running one. */
    readonly enable: (input: HomeEnableInput) => Effect.Effect<HomeThreadResult, HomeError>;
    /** Turns Home off: its grant and watches go at once and its run is stopped. */
    readonly disable: Effect.Effect<void, HomeError>;
    /** Moves Home to a new thread and stops and settles the old one. */
    readonly reset: Effect.Effect<HomeThreadResult, HomeError>;
    readonly setModel: (modelSelection: ModelSelection) => Effect.Effect<void, HomeError>;
  }
>()("t3/home/HomeService") {}

const failWith = (reason: HomeError["reason"]) => (cause: unknown) =>
  new HomeError({ reason, cause });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const bots = yield* BotService.BotService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);

  const folder = homeFolderRoot(config.baseDir, path);

  const read = settings.getSettings.pipe(
    Effect.map((current) => current.home),
    Effect.mapError(failWith("settings-unavailable")),
  );
  const write = (home: HomeSettings) =>
    settings.updateSettings({ home }).pipe(
      Effect.map((current) => current.home),
      Effect.mapError(failWith("settings-unavailable")),
    );
  const newId = random.uuidV4().pipe(Effect.orDie);

  const liveShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell === null || shell.deletedAt !== null || shell.archivedAt !== null ? null : shell,
      ),
      Effect.orElseSucceed(() => null),
    );

  // Instructions ride on each turn (`botInstructions.ts`), so none are kept in the folder: an
  // AGENTS.md left by an earlier version would go stale.
  const ensureFolder = fileSystem
    .makeDirectory(folder, { recursive: true })
    .pipe(Effect.andThen(fileSystem.remove(path.join(folder, "AGENTS.md"), { force: true })));

  const ensureProject = Effect.gen(function* () {
    yield* ensureFolder.pipe(Effect.mapError(failWith("launch-failed")));
    const id = yield* newId;
    const { project } = yield* projects
      .bootstrap({
        commandId: CommandId.make(`home-project:${id}`),
        projectId: ProjectId.make(id),
        title: "Home",
        workspaceRoot: folder,
      })
      .pipe(
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId } }),
        }),
        Effect.mapError(failWith("launch-failed")),
      );
    return project.id;
  });

  const resolveModel = Effect.fn("HomeService.resolveModel")(function* (
    requested: ModelSelection | undefined,
    home: HomeSettings,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(failWith("settings-unavailable")),
    );
    const model = requested ?? home.modelSelection ?? current.defaultModelSelection;
    return model ?? (yield* new HomeError({ reason: "no-model" }));
  });

  const launchHome = Effect.fn("HomeService.launchHome")(function* (
    modelSelection: ModelSelection,
  ) {
    const projectId = yield* ensureProject;
    const id = yield* newId;
    const result = yield* launches
      .launch({
        commandId: CommandId.make(`${HOME_THREAD_ID_PREFIX}${id}`),
        threadId: ThreadId.make(`${HOME_THREAD_ID_PREFIX}${id}`),
        projectId,
        title: "Home",
        modelSelection,
        // Home acts with the user's reach: the MCP mode check stops a caller from acting on a
        // thread broader than itself. A user who switches Home to plan makes it read-only.
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
        botConfig: { enabled: true, muteChildren: false },
      })
      .pipe(Effect.mapError(failWith("launch-failed")));
    return result.threadId;
  });

  /**
   * Stops a former Home after its grant moved, so it does not keep working beside the new one.
   * Best effort: interrupting with `holdQueue` keeps queued turns from starting after it.
   */
  const stopFormerHome = Effect.fn("HomeService.stopFormerHome")(function* (threadId: ThreadId) {
    const shell = yield* liveShell(threadId);
    if (shell === null || shell.activeRunId === null) return;
    yield* threads
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`home-stop:${yield* newId}`),
        threadId,
        runId: shell.activeRunId,
        reason: "Home was turned off or started fresh.",
        holdQueue: true,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const enable: HomeService["Service"]["enable"] = Effect.fn("HomeService.enable")(function* (
    input,
  ) {
    const home = yield* read;
    if (home.enabled && home.threadId !== null && (yield* liveShell(home.threadId)) !== null) {
      return { threadId: home.threadId };
    }
    const modelSelection = yield* resolveModel(input.modelSelection, home);
    const threadId = yield* launchHome(modelSelection);
    yield* write({ ...home, enabled: true, threadId, modelSelection });
    if (home.threadId !== null && home.threadId !== threadId)
      yield* bots.clearWatches(home.threadId);
    return { threadId };
  }, locked);

  const disable: HomeService["Service"]["disable"] = Effect.gen(function* () {
    const home = yield* read;
    // The grant goes first; stopping the old run comes after.
    yield* write({ ...DEFAULT_HOME_SETTINGS, modelSelection: home.modelSelection });
    if (home.threadId !== null) {
      yield* bots.clearWatches(home.threadId);
      yield* stopFormerHome(home.threadId);
    }
  }).pipe(locked, Effect.withSpan("HomeService.disable"));

  const reset: HomeService["Service"]["reset"] = Effect.gen(function* () {
    const home = yield* read;
    if (!home.enabled || home.threadId === null) return yield* new HomeError({ reason: "off" });
    const former = home.threadId;
    const modelSelection = yield* resolveModel(undefined, home);
    const threadId = yield* launchHome(modelSelection);
    yield* write({ ...home, threadId, modelSelection });
    yield* bots.clearWatches(former);
    yield* stopFormerHome(former);
    // Work Home started goes on, so its crew follows Home to the new thread.
    yield* bots.moveCrew(former, threadId).pipe(Effect.ignoreCause({ log: true }));
    // The old Home stays in history, out of the active list.
    yield* threads
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`home-settle:${yield* newId}`),
        threadId: former,
      })
      .pipe(Effect.ignore);
    return { threadId };
  }).pipe(locked, Effect.withSpan("HomeService.reset"));

  const setModel: HomeService["Service"]["setModel"] = Effect.fn("HomeService.setModel")(function* (
    modelSelection,
  ) {
    const home = yield* read;
    yield* write({ ...home, modelSelection });
    if (home.threadId === null || (yield* liveShell(home.threadId)) === null) return;
    yield* threads
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`home-model:${yield* newId}`),
        threadId: home.threadId,
        modelSelection,
      })
      .pipe(Effect.mapError(failWith("launch-failed")));
  }, locked);

  return HomeService.of({
    read,
    enable,
    disable,
    reset,
    setModel,
  });
});

export const layer = Layer.effect(HomeService, make);
