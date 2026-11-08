import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  CommandId,
  LessonCreateError,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadLaunchService from "../ThreadLaunchService.ts";
import { ThreadManagementProviderInstanceDisabledError } from "../ThreadManagementService.ts";
import { buildLessonOpening } from "./LessonService.ts";
import * as LessonModule from "./LessonService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";

const lessonInput = (commandId: CommandId, projectId?: ProjectId) => ({
  ...(projectId === undefined ? {} : { projectId }),
  commandId,
  lesson: { topic: "topic", depth: "working" as const, purpose: "outcome" as const },
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const lessonWorkspaceRoot = (baseDir: string, name: string) => `${baseDir}/lessons/${name}`;

const failingLaunch = (commandId: CommandId) =>
  Effect.fail(
    new ThreadManagementProviderInstanceDisabledError({
      projectId: ProjectId.make(`lesson-project:${commandId}`),
      instanceId: modelSelection.instanceId,
    }),
  );

const runFailedCreate = (
  input: ReturnType<typeof lessonInput>,
  options: {
    readonly baseDir: string;
    readonly folders: ManagedProjectFolders.ManagedProjectFolders["Service"];
    readonly projects: ProjectService.ProjectService["Service"];
  },
) =>
  Effect.gen(function* () {
    const service = yield* LessonModule.LessonService;
    return yield* service.create(input);
  }).pipe(
    Effect.provide(
      lessonLayer(
        () => Effect.die("unused"),
        () => failingLaunch(input.commandId),
        options,
      ),
    ),
    Effect.flip,
  );

const sourceThreadId = ThreadId.make("thread:source");
const targetProjectId = ProjectId.make("project:target");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} satisfies ModelSelection;

const lessonLayer = (
  getThread: ProjectionStore.ProjectionStoreV2["Service"]["getThread"],
  launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"],
  options?: {
    readonly folders?: ManagedProjectFolders.ManagedProjectFolders["Service"];
    readonly projects?: ProjectService.ProjectService["Service"];
    readonly baseDir?: string;
  },
) =>
  LessonModule.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThread,
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch,
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
          getDescriptor: Effect.die("unused"),
        }),
        Layer.succeed(
          ManagedProjectFolders.ManagedProjectFolders,
          options?.folders ??
            ({
              createNamedProject: () => Effect.die("unused"),
            } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"]),
        ),
        Layer.succeed(
          ProjectService.ProjectService,
          options?.projects ??
            ({
              getById: () => Effect.succeedNone,
            } as unknown as ProjectService.ProjectService["Service"]),
        ),
        ServerConfig.layerTest(process.cwd(), options?.baseDir ?? process.cwd()).pipe(
          Layer.provide(NodeServices.layer),
          Layer.orDie,
        ),
        NodeServices.layer,
      ),
    ),
  );

it.effect("creates a lesson with persisted answers, opening text, and source context", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ThreadLaunchService.ThreadLaunchInput | null>(null);
    const lesson = {
      topic: "event sourcing",
      depth: "working" as const,
      purpose: "prerequisite" as const,
      history: "didnt-stick" as const,
      goal: "build a durable app",
      source: { threadId: sourceThreadId, excerpt: "Events are facts.\nState is derived." },
    };
    const result = yield* Effect.gen(function* () {
      const service = yield* LessonModule.LessonService;
      return yield* service.create({
        commandId: CommandId.make("lesson:test"),
        projectId: targetProjectId,
        lesson,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
    }).pipe(
      Effect.provide(
        lessonLayer(
          () =>
            Effect.succeed({
              id: sourceThreadId,
              projectId: ProjectId.make("project:source"),
              title: "Source chat",
              deletedAt: null,
            }) as never,
          (input) =>
            Effect.gen(function* () {
              yield* Ref.set(launched, input);
              return {
                threadId: ThreadId.make("thread:lesson"),
              } as ThreadLaunchService.ThreadLaunchResult;
            }),
        ),
      ),
    );
    const request = yield* Ref.get(launched);
    assert.include(buildLessonOpening(lesson), "Working knowledge");
    assert.equal(result.threadId, ThreadId.make("thread:lesson"));
    assert.deepEqual(request?.lesson, lesson);
    assert.equal(request?.projectId, ProjectId.make("project:source"));
    assert.include(request?.initialMessage?.text ?? "", "event sourcing");
    assert.include(request?.initialMessage?.text ?? "", "Working knowledge");
    assert.include(
      request?.initialMessage?.text ?? "",
      "for build a durable app\nHistory: Seen it, didn't stick\n",
    );
    assert.include(request?.initialMessage?.text ?? "", "> Events are facts.");
    assert.include(request?.initialMessage?.text ?? "", "> State is derived.");
    const sourceRecord = request?.initialMessage?.context?.records.find(
      (record) => "threadId" in record,
    );
    assert.equal(sourceRecord?.threadId, sourceThreadId);
    assert.equal(sourceRecord?.environmentId, EnvironmentId.make("test-environment"));
    assert.include(
      request?.initialMessage?.text ?? "",
      `From this passage in [Source chat](t3-context://v1/thread/${sourceRecord?.contextId})`,
    );
  }),
);

const commandId = CommandId.make("lesson:refused");
const refusals = [
  new ThreadLaunchService.ThreadLaunchError({
    operation: "create-thread",
    commandId,
    projectId: targetProjectId,
    cause: new OrchestratorRuntimeModeAboveCeilingError({
      commandId,
      threadId: ThreadId.make("thread:lesson-ceiling"),
      refused: "mode",
      runtimeMode: "full-access",
      maxRuntimeMode: "approval-required",
      organization: "Example Corp",
    }),
  }),
  new ThreadManagementProviderInstanceDisabledError({
    projectId: targetProjectId,
    instanceId: modelSelection.instanceId,
  }),
];

it.effect.each(refusals)(
  "reports $_tag refusals as invalid requests with their reason",
  (refusal) =>
    Effect.gen(function* () {
      const error = yield* Effect.gen(function* () {
        const service = yield* LessonModule.LessonService;
        return yield* service.create({
          commandId,
          projectId: targetProjectId,
          lesson: { topic: "event sourcing", depth: "working", purpose: "outcome" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
      }).pipe(
        Effect.provide(
          lessonLayer(
            () => Effect.die("unused"),
            () => Effect.fail(refusal),
          ),
        ),
        Effect.flip,
      );
      const reason = refusal._tag === "ThreadLaunchError" ? (refusal.cause as Error) : refusal;
      assert.equal(error.message, reason.message);
      assert.equal(error.invalidRequest, true);
    }),
);

it.effect("cleans up a newly created lesson project when launch fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "lesson-create-" });
    const deleted = yield* Ref.make<ReadonlyArray<ProjectService.ProjectDeleteInput>>([]);
    const workspaceRoot = lessonWorkspaceRoot(baseDir, "topic");
    const error = yield* runFailedCreate(lessonInput(CommandId.make("lesson:cleanup")), {
      baseDir,
      folders: {
        createNamedProject: () =>
          fs.makeDirectory(workspaceRoot, { recursive: true }).pipe(
            Effect.as({
              projectId: ProjectId.make("lesson-project:lesson:cleanup"),
              workspaceRoot,
            }),
          ),
      } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"],
      projects: {
        getById: () => Effect.succeedNone,
        delete: (input: ProjectService.ProjectDeleteInput) =>
          Ref.update(deleted, (items) => [...items, input]).pipe(Effect.as({} as never)),
      } as unknown as ProjectService.ProjectService["Service"],
    });
    assert.instanceOf(error, LessonCreateError);
    assert.deepEqual(yield* Ref.get(deleted), [
      {
        commandId: CommandId.make("lesson-project-cleanup:lesson-project:lesson:cleanup"),
        projectId: ProjectId.make("lesson-project:lesson:cleanup"),
      },
    ]);
    assert.equal(yield* fs.exists(workspaceRoot), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the folder when deleting a failed lesson project fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "lesson-create-" });
    const workspaceRoot = lessonWorkspaceRoot(baseDir, "topic");
    const error = yield* runFailedCreate(lessonInput(CommandId.make("lesson:delete-fails")), {
      baseDir,
      folders: {
        createNamedProject: () =>
          fs.makeDirectory(workspaceRoot, { recursive: true }).pipe(
            Effect.as({
              projectId: ProjectId.make("lesson-project:lesson:delete-fails"),
              workspaceRoot,
            }),
          ),
      } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"],
      projects: {
        getById: () => Effect.succeedNone,
        delete: () =>
          Effect.fail(
            new ProjectService.ProjectNotEmptyError({
              projectId: ProjectId.make("lesson-project:lesson:delete-fails"),
            }),
          ),
      } as unknown as ProjectService.ProjectService["Service"],
    });
    assert.instanceOf(error, LessonCreateError);
    assert.equal(yield* fs.exists(workspaceRoot), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not clean up a caller supplied project when launch fails", () =>
  Effect.gen(function* () {
    const deleted = yield* Ref.make(0);
    const projectId = ProjectId.make("project:caller");
    const error = yield* runFailedCreate(lessonInput(CommandId.make("lesson:caller"), projectId), {
      baseDir: "/tmp",
      folders: {} as ManagedProjectFolders.ManagedProjectFolders["Service"],
      projects: {
        getById: () => Effect.succeedNone,
        delete: () => Ref.update(deleted, (count) => count + 1),
      } as unknown as ProjectService.ProjectService["Service"],
    });
    assert.instanceOf(error, LessonCreateError);
    assert.equal(yield* Ref.get(deleted), 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "creates its own project, replaces it after cleanup, and never cleans up a reused one",
  () =>
    Effect.gen(function* () {
      const created = yield* Ref.make(0);
      const createInputs = yield* Ref.make<
        ReadonlyArray<{ name: string; root?: "lessons"; projectId?: ProjectId }>
      >([]);
      const lookups = yield* Ref.make(0);
      const deletes = yield* Ref.make(0);
      const launches = yield* Ref.make<ThreadLaunchService.ThreadLaunchInput[]>([]);
      const commandId = CommandId.make("lesson:retry");
      const derivedProjectId = ProjectId.make(`lesson-project:${commandId}`);
      const result = yield* Effect.gen(function* () {
        const service = yield* LessonModule.LessonService;
        const input = {
          commandId,
          lesson: {
            topic: "A very useful topic",
            depth: "working" as const,
            purpose: "outcome" as const,
          },
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        const first = yield* service.create(input).pipe(Effect.flip);
        const second = yield* service.create(input);
        const third = yield* service.create(input).pipe(Effect.flip);
        return { first, second, third };
      }).pipe(
        Effect.provide(
          lessonLayer(
            () => Effect.die("unused"),
            (input) =>
              Effect.gen(function* () {
                const count = (yield* Ref.get(launches)).length;
                yield* Ref.update(launches, (items) => [...items, input]);
                if (count !== 1) return yield* failingLaunch(commandId);
                return {
                  threadId: ThreadId.make(`thread:${(yield* Ref.get(launches)).length}`),
                } as ThreadLaunchService.ThreadLaunchResult;
              }),
            {
              folders: {
                createNamedProject: (input: {
                  readonly name: string;
                  readonly root?: "lessons";
                  readonly projectId?: ProjectId;
                }) =>
                  Ref.update(createInputs, (items) => [...items, input]).pipe(
                    Effect.andThen(Ref.updateAndGet(created, (count) => count + 1)),
                    Effect.as({
                      projectId: input.projectId ?? ProjectId.make("created:fresh"),
                      workspaceRoot: `/lessons/${input.name}`,
                    }),
                  ),
              } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"],
              projects: {
                getById: () =>
                  Ref.updateAndGet(lookups, (count) => count + 1).pipe(
                    Effect.map((count) =>
                      count === 1
                        ? Option.none()
                        : Option.some(
                            (count === 2
                              ? { id: derivedProjectId, deletedAt: "2026-01-01T00:00:00.000Z" }
                              : { id: ProjectId.make("created:fresh"), deletedAt: null }) as never,
                          ),
                    ),
                  ),
                delete: () =>
                  Ref.update(deletes, (count) => count + 1).pipe(Effect.as({} as never)),
              } as unknown as ProjectService.ProjectService["Service"],
            },
          ),
        ),
      );
      assert.instanceOf(result.first, LessonCreateError);
      assert.equal(result.second.threadId, ThreadId.make("thread:2"));
      assert.instanceOf(result.third, LessonCreateError);
      assert.equal(yield* Ref.get(created), 2);
      assert.equal(yield* Ref.get(deletes), 1);
      assert.deepEqual(yield* Ref.get(createInputs), [
        { name: "A very useful topic", root: "lessons", projectId: derivedProjectId },
        { name: "A very useful topic", root: "lessons" },
      ]);
      assert.deepEqual(
        (yield* Ref.get(launches)).map((input) => input.projectId),
        [derivedProjectId, ProjectId.make("created:fresh"), ProjectId.make("created:fresh")],
      );
    }),
);

it("asks to follow a course when the topic is a link", () => {
  const opening = LessonModule.buildLessonOpening({
    topic: "https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/",
    depth: "working",
    purpose: "prerequisite",
  } as Parameters<typeof LessonModule.buildLessonOpening>[0]);
  assert.match(opening, /^I'd like to follow this course: https:\/\/ocw\.mit\.edu/);
});
