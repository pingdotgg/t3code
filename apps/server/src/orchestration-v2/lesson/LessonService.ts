import {
  CommandId,
  LessonCreateError,
  ProjectId,
  type OrchestrationV2Lesson,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2LinkOrigin,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadLaunchService from "../ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerConfig from "../../config.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../Orchestrator.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { truncate } from "@t3tools/shared/String";

const LESSON_DEPTH_LABELS = {
  overview: ["Big picture", "the main ideas and how they fit together"],
  working: ["Working knowledge", "enough to use it confidently"],
  deep: ["Deep detail", "the mechanics, edge cases and why it works"],
} as const;

const LESSON_HISTORY_LABELS = {
  new: "New to me",
  "didnt-stick": "Seen it, didn't stick",
  "want-depth": "Know it, want depth",
} as const;

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

export function buildLessonOpening(
  lesson: OrchestrationV2Lesson,
  sourceChat = "another chat",
): string {
  const [label, explanation] = LESSON_DEPTH_LABELS[lesson.depth];
  const why = lesson.purpose === "outcome" ? "Toward an outcome" : "Building prerequisites";
  const goal = lesson.goal === undefined ? "" : `, for ${lesson.goal}`;
  const history =
    lesson.history === undefined ? "" : `\nHistory: ${LESSON_HISTORY_LABELS[lesson.history]}`;
  const source =
    lesson.source === undefined
      ? ""
      : `\nFrom this passage in ${sourceChat}:\n${lesson.source.excerpt
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`;
  // A pasted course link (APP-43) makes the lesson follow that course.
  const ask = /^https?:\/\/\S+$/.test(lesson.topic.trim())
    ? "I'd like to follow this course"
    : "I'd like a lesson on";
  return `${ask}: ${lesson.topic}\nHow deep: ${label} (${explanation})\nWhy: ${why}${goal}${history}\n${source}\nStart by checking what I already know about this, then teach at that depth and keep examples tied to why I'm learning it.`;
}

export class LessonService extends Context.Service<
  LessonService,
  {
    readonly create: (input: {
      readonly projectId?: import("@t3tools/contracts").ProjectId;
      readonly commandId: CommandId;
      readonly lesson: OrchestrationV2Lesson;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly createdBy: "user" | "agent";
      readonly creationSource: "web" | "mcp";
      readonly linkOrigin?: OrchestrationV2LinkOrigin;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, LessonCreateError>;
  }
>()("t3/orchestration-v2/lesson/LessonService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;

  const create: LessonService["Service"]["create"] = Effect.fn("LessonService.create")(
    function* (input) {
      let projectId = input.projectId;
      let created: { readonly projectId: ProjectId; readonly workspaceRoot: string } | undefined;
      const title = truncate(input.lesson.topic.replaceAll(/\s+/g, " "), 80);
      let context: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
      let sourceChat: string | undefined;
      if (input.lesson.source !== undefined) {
        const source = yield* projections
          .getThread(input.lesson.source.threadId)
          .pipe(
            Effect.mapError(
              () => new LessonCreateError({ message: "Source thread was not found." }),
            ),
          );
        if (source.deletedAt !== null) {
          return yield* new LessonCreateError({ message: "Source thread was deleted." });
        }
        if (input.projectId !== undefined) projectId = source.projectId;
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        const record = threadContextRecord({ environmentId, threadId: source.id }, source.title);
        context = { version: 1, records: [record] };
        // A context record shows as a chip only where the text references it.
        sourceChat = formatComposerContextReference(record);
      }
      if (projectId === undefined) {
        const lessonProjectId = ProjectId.make(`lesson-project:${input.commandId}`);
        const existing = yield* projects
          .getById(lessonProjectId, { includeDeleted: true })
          .pipe(
            Effect.mapError(
              () => new LessonCreateError({ message: "Failed to find the lesson project." }),
            ),
          );
        if (Option.isSome(existing) && existing.value.deletedAt === null) {
          projectId = existing.value.id;
        } else {
          created = yield* folders
            .createNamedProject({
              name: title,
              root: "lessons",
              ...(Option.isNone(existing) ? { projectId: lessonProjectId } : {}),
            })
            .pipe(Effect.mapError((error) => new LessonCreateError({ message: error.message })));
          projectId = created.projectId;
        }
      }
      const owned = created;
      const cleanup =
        owned === undefined
          ? Effect.void
          : projects
              .delete({
                commandId: CommandId.make(`lesson-project-cleanup:${owned.projectId}`),
                projectId: owned.projectId,
              })
              .pipe(
                Effect.flatMap(() => {
                  const workspaceRoot = path.resolve(owned.workspaceRoot);
                  const lessonsRoot = path.resolve(config.baseDir, "lessons");
                  return path.dirname(workspaceRoot) === lessonsRoot
                    ? fileSystem.remove(workspaceRoot, { recursive: true })
                    : Effect.void;
                }),
                Effect.ignore,
              );
      const launched = yield* threadLaunch
        .launch({
          commandId: input.commandId,
          projectId,
          title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            text: buildLessonOpening(input.lesson, sourceChat),
            attachments: [],
            ...(context === undefined ? {} : { context }),
          },
          lesson: input.lesson,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
        })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new LessonCreateError({ message: error.message, invalidRequest: true });
            }
            if (error._tag === "ThreadLaunchError" && isAboveCeilingError(error.cause)) {
              return new LessonCreateError({
                message: error.cause.message,
                invalidRequest: true,
              });
            }
            return new LessonCreateError({ message: error.message });
          }),
          Effect.onError(() => cleanup),
        );
      return { threadId: launched.threadId };
    },
  );
  return LessonService.of({ create });
});

export const layer = Layer.effect(LessonService, make);
