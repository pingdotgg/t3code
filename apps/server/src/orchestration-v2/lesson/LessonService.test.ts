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

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadLaunchService from "../ThreadLaunchService.ts";
import { buildLessonOpening } from "./LessonService.ts";
import * as LessonModule from "./LessonService.ts";

const sourceThreadId = ThreadId.make("thread:source");
const targetProjectId = ProjectId.make("project:target");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} satisfies ModelSelection;

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
        Layer.mergeAll(
          LessonModule.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                  getThread: () =>
                    Effect.succeed({
                      id: sourceThreadId,
                      projectId: ProjectId.make("project:source"),
                      title: "Source chat",
                      deletedAt: null,
                    }),
                } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
                Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
                  launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
                    Effect.gen(function* () {
                      yield* Ref.set(launched, input);
                      return {
                        threadId: ThreadId.make("thread:lesson"),
                      } as ThreadLaunchService.ThreadLaunchResult;
                    }),
                } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
                Layer.succeed(ServerEnvironment.ServerEnvironment, {
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
                  getDescriptor: Effect.die("unused"),
                }),
              ),
            ),
          ),
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

it("asks to follow a course when the topic is a link", () => {
  const opening = LessonModule.buildLessonOpening({
    topic: "https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/",
    depth: "working",
    purpose: "prerequisite",
  } as Parameters<typeof LessonModule.buildLessonOpening>[0]);
  assert.match(opening, /^I'd like to follow this course: https:\/\/ocw\.mit\.edu/);
});
