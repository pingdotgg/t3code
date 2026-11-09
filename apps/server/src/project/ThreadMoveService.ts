import {
  CommandId,
  ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  ThreadMoveError,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { nativeStorageFolders } from "../orchestration-v2/NativeStorageFolder.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "../terminal/Manager.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectLock from "./ProjectLock.ts";
import * as ProjectService from "./ProjectService.ts";
import {
  collectMoveSet,
  decideThreadMove,
  type ThreadMoveProbes,
  type ThreadMoveProviderInstance,
} from "./ThreadMoveDestination.ts";
import { planThreadMove, type ThreadMoveMember } from "./ThreadMovePlan.ts";

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("t3/project/ThreadMoveService") {}

type Refused = Extract<ThreadMoveResult, { _tag: "refused" }>;

const refused = (reason: string): Refused => ({ _tag: "refused", reason });
const destinationGone = refused("The destination project no longer exists.");

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projectLocks = yield* ProjectLock.ProjectLock;
  const eventSink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const random = yield* SecureRandom.SecureRandom;

  const fail = (message: string) => (cause: unknown) => new ThreadMoveError({ message, cause });
  const resolve = (folder: string) =>
    fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => path.resolve(folder)));
  // FileSystem.remove needs `recursive` for any folder, so the listing stands in for rmdir.
  const removeEmptyFolder = (folder: string) =>
    Effect.flatMap(fileSystem.readDirectory(folder), (entries) =>
      entries.length === 0 ? fileSystem.remove(folder, { recursive: true }) : Effect.void,
    );

  const probes: ThreadMoveProbes = {
    fileSystem,
    path,
    threadRecords: (threadId) =>
      threads
        .getThreadRecords(threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail("Could not read the thread."))),
    hasBackgroundWork: (threadId) =>
      threads
        .threadHasBackgroundWork(threadId)
        .pipe(Effect.mapError(fail("Could not probe the thread's background work."))),
  };

  const providerInstance = Effect.fn("ThreadMoveService.providerInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) return undefined;
    const environment = yield* resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId: instanceId,
      env: hostEnvironment as Record<string, string>,
    }).pipe(Effect.mapError(fail("Could not resolve the provider's environment.")));
    return {
      driver: instance.driverKind,
      capabilities: yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.mapError(fail("Could not read the provider's capabilities."))),
      version: (yield* instance.snapshot.getSnapshot).version ?? null,
      environment,
    } satisfies ThreadMoveProviderInstance;
  });

  const readShells = threads.getShellSnapshot().pipe(
    Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]),
    Effect.mapError(fail("Could not read the threads.")),
  );

  const decide = Effect.fn("ThreadMoveService.decide")(function* (request: ThreadMoveInput) {
    const shells = yield* readShells;
    const { projects: projectList } = yield* projects.snapshot.pipe(
      Effect.mapError(fail("Could not read the projects.")),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(fail("Could not read the settings.")),
    );
    const members = collectMoveSet(request.threadId, shells);
    const instances = new Map<ProviderInstanceId, ThreadMoveProviderInstance>();
    for (const id of new Set(members.map((member) => member.providerInstanceId))) {
      const instance = yield* providerInstance(id);
      if (instance !== undefined) instances.set(id, instance);
    }
    const decision = yield* decideThreadMove(
      {
        request,
        threads: shells,
        projects: projectList,
        providerInstances: instances,
        settings,
        scratchRoot: Option.getOrUndefined(yield* managedFolders.scratchRoot),
        managedWorktreeDirectories: managedWorktreesDirectories(
          settings,
          config.worktreesDir,
          path,
          home,
        ),
        home,
      },
      probes,
    );
    const relocating =
      decision._tag !== "refused" &&
      decision._tag !== "moved" &&
      (yield* outbox
        .hasUnsettled({
          threadIds: members.map((member) => member.id),
          effectType: "provider-session.relocate-storage",
        })
        .pipe(Effect.mapError(fail("Could not read the thread's pending moves."))));
    return {
      projects: projectList,
      decision: relocating
        ? refused("The last move is still relocating a Claude session. Try again in a moment.")
        : decision,
    };
  });

  const addProject = Effect.fn("ThreadMoveService.addProject")(
    function* (folder: string) {
      const id = yield* random.uuidV4();
      return yield* projects
        .create({
          commandId: CommandId.make(`thread-move-project:${id}`),
          projectId: ProjectId.make(id),
          title: path.basename(folder),
          workspaceRoot: folder,
        })
        .pipe(
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              projects
                .getById(conflict.conflictingProjectId)
                .pipe(Effect.flatMap(Effect.fromOption)),
          }),
        );
    },
    Effect.mapError(fail("Could not add the project.")),
  );

  const lockMembers = (
    threadId: ThreadId,
    locked: Array<ThreadId>,
    body: Effect.Effect<ThreadMoveResult, ThreadMoveError>,
  ): Effect.Effect<ThreadMoveResult, ThreadMoveError> =>
    threadLocks.withLock(
      threadId,
      Effect.flatMap(readShells, (shells) => {
        locked.push(threadId);
        return collectMoveSet(threadId, shells)
          .filter((child) => child.lineage.parentThreadId === threadId)
          .reduceRight((inner, child) => lockMembers(child.id, locked, inner), body);
      }),
    );

  const apply = Effect.fn("ThreadMoveService.apply")(function* (
    input: ThreadMoveInput,
    projectId: ProjectId,
    lockedIds: ReadonlyArray<ThreadId>,
  ) {
    const project = Option.getOrUndefined(
      yield* projects
        .getById(projectId)
        .pipe(Effect.mapError(fail("Could not read the destination project."))),
    );
    if (project === undefined) return destinationGone;
    if (project.archivedAt != null)
      return refused(`The destination project "${project.title}" is archived.`);
    const { projects: projectList, decision } = yield* decide(input);
    if (decision._tag !== "move") return decision;
    const target = decision.destination;
    if (
      target._tag === "new-project" ||
      target.project?.id !== projectId ||
      collectMoveSet(input.threadId, yield* readShells).some(({ id }) => !lockedIds.includes(id))
    ) {
      return refused("The thread or its destination changed. Try again.");
    }
    const [thread] = decision.members;
    const previousProject = projectList.find((candidate) => candidate.id === thread?.projectId);
    if (thread === undefined || previousProject === undefined) {
      return refused("This thread's project no longer exists.");
    }
    const worktreePath =
      target._tag !== "scratch"
        ? null
        : Option.getOrUndefined(
            yield* managedFolders
              .folderForThread({ projectId, threadId: thread.id, text: thread.title })
              .pipe(Effect.mapError(fail("Could not claim a scratch folder."))),
          );
    if (worktreePath === undefined)
      return refused("Scratch folders are unavailable on this server.");
    const folder = worktreePath ?? project.workspaceRoot;
    const previousFolder = thread.worktreePath ?? previousProject.workspaceRoot;
    const commit = Effect.gen(function* () {
      const members: Array<ThreadMoveMember> = [];
      for (const member of decision.members) {
        const unreadable = fail(`Could not read "${member.title}".`);
        const projection = yield* threads
          .getThreadRecords(
            member.id,
            ["providerSessions", "providerThreads", "runs", "attempts"],
            { turnItemTypes: [] },
          )
          .pipe(Effect.mapError(unreadable));
        members.push({
          projection,
          previousFolder: member.worktreePath ?? previousProject.workspaceRoot,
          storageFolders: yield* nativeStorageFolders(eventStore, member.id, projection).pipe(
            Effect.mapError(unreadable),
          ),
          nextOrdinal: yield* projections
            .getNextTurnItemOrdinal(member.id)
            .pipe(Effect.mapError(unreadable)),
        });
      }
      const moving = members[0]?.projection.thread;
      const tracked = moving?.branch == null ? null : (moving.branchPullRequest ?? null);
      const now = yield* DateTime.now;
      const command = {
        type: "thread.project.move" as const,
        commandId: CommandId.make(
          `thread-move:${yield* random.uuidV4().pipe(Effect.mapError(fail("Could not plan the move.")))}`,
        ),
        threadId: thread.id,
        projectId,
        worktreePath,
      };
      const plan = yield* planThreadMove({
        command,
        members,
        folder,
        folderChanged: (yield* resolve(previousFolder)) !== (yield* resolve(folder)),
        receipt: {
          folder,
          previousFolder,
          project: project.title,
          previousProject: previousProject.title,
          members: decision.members.slice(1).map((member) => member.title),
          clearedBranch: moving?.branch ?? null,
          pullRequest: tracked === null ? null : { number: tracked.number, url: tracked.url },
          leftFolder:
            decision.leaving === null
              ? null
              : {
                  exists: yield* fileSystem
                    .exists(previousFolder)
                    .pipe(Effect.orElseSucceed(() => true)),
                  project: decision.leaving.project?.title ?? null,
                  otherThreads: decision.leaving.otherThreads.map((other) => other.title),
                },
        },
        now,
        idAllocator,
      }).pipe(Effect.mapError(fail("Could not plan the move.")));
      yield* eventSink
        .commitCommand({
          commandId: command.commandId,
          commandType: command.type,
          threadId: thread.id,
          acceptedAt: now,
          events: plan.events,
          effects: plan.effects,
        })
        .pipe(Effect.mapError(fail("Could not commit the move.")));
      return {
        _tag: "moved" as const,
        folder,
        members: decision.members.map((member) => ({ threadId: member.id, title: member.title })),
      };
    });
    return yield* worktreePath === null
      ? commit
      : commit.pipe(Effect.onError(() => removeEmptyFolder(worktreePath).pipe(Effect.ignore)));
  });

  const move: ThreadMoveService["Service"]["move"] = Effect.fn("ThreadMoveService.move")(
    function* (input) {
      const first = yield* decide(input);
      if (first.decision._tag !== "move") return first.decision;
      const { destination } = first.decision;
      const added =
        destination._tag === "new-project" ? yield* addProject(destination.folder) : undefined;
      const projectId =
        (destination._tag === "new-project" ? added : destination.project)?.id ??
        (yield* managedFolders.ensureScratchProject.pipe(
          Effect.mapError(fail("Scratch folders are unavailable on this server.")),
        )).projectId;
      const locked: Array<ThreadId> = [];
      const result = yield* projectLocks.withLock(
        projectId,
        lockMembers(input.threadId, locked, apply(input, projectId, locked)),
      );
      if (added === undefined || result._tag === "moved") return result;
      const refusal =
        result._tag === "refused" ? result : refused("The thread changed. Try again.");
      const stays = result === destinationGone ? "" : " and stays";
      return {
        ...refusal,
        reason: `${refusal.reason} The project "${added.title}" was added${stays}.`,
        projects: [...(refusal.projects ?? []), { projectId: added.id, title: added.title }],
      };
    },
  );

  return ThreadMoveService.of({ move });
});

export const layer = Layer.effect(ThreadMoveService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(ProjectLock.layer),
);
