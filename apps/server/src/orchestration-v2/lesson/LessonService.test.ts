import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadLaunchService from "../ThreadLaunchService.ts";
import { ThreadManagementProviderInstanceDisabledError } from "../ThreadManagementService.ts";
import { buildLessonOpening } from "./LessonService.ts";
import * as LessonModule from "./LessonService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";

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
    assert.include(request?.initialMessage?.text ?? "", "for build a durable app");
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

it.effect("creates its own project when projectId is absent, and reuses it on retry", () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(0);
    const createInputs = yield* Ref.make<
      ReadonlyArray<{ name: string; root?: "lessons"; projectId?: ProjectId }>
    >([]);
    const lookups = yield* Ref.make(0);
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
      const first = yield* service.create(input);
      const second = yield* service.create(input);
      return { first, second };
    }).pipe(
      Effect.provide(
        lessonLayer(
          () => Effect.die("unused"),
          (input) =>
            Effect.gen(function* () {
              yield* Ref.update(launches, (items) => [...items, input]);
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
                    projectId: derivedProjectId,
                    workspaceRoot: `/lessons/${input.name}`,
                  }),
                ),
            } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"],
            projects: {
              getById: () =>
                Ref.updateAndGet(lookups, (count) => count + 1).pipe(
                  Effect.map((count) =>
                    count === 1 ? Option.none() : Option.some({ id: derivedProjectId } as never),
                  ),
                ),
            } as unknown as ProjectService.ProjectService["Service"],
          },
        ),
      ),
    );
    assert.equal(result.first.threadId, ThreadId.make("thread:1"));
    assert.equal(result.second.threadId, ThreadId.make("thread:2"));
    assert.equal(yield* Ref.get(created), 1);
    assert.deepEqual(yield* Ref.get(createInputs), [
      { name: "A very useful topic", root: "lessons", projectId: derivedProjectId },
    ]);
    assert.deepEqual(
      (yield* Ref.get(launches)).map((input) => input.projectId),
      [derivedProjectId, derivedProjectId],
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
