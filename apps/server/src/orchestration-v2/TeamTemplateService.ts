import {
  CommandId,
  CONTRIBUTOR_BUNDLE_FILE_NAME,
  type ContributorBundleOrientation,
  type OrchestrationV2AddSpecialistsFromTemplateInput,
  type OrchestrationV2AddSpecialistsFromTemplateResult,
  OrchestrationV2AddSpecialistsFromTemplateError,
  type OrchestrationV2PreviewSpecialistTemplateInput,
  type OrchestrationV2PreviewSpecialistTemplateResult,
  OrchestrationV2PreviewSpecialistTemplateError,
  type ProjectId,
  type SpecialistTemplateSource,
  type ThreadId,
  type ThreadSpecialist,
  formatWorkshopLeadPrompt,
  teamTemplateById,
} from "@t3tools/contracts";
import {
  formatContributorBundleLeadPrompt,
  formatContributorBundleSeatBrief,
} from "@t3tools/shared/contributorBundle";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ContributorBundleLoader from "../project/ContributorBundleLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type ResolvedSpecialistRecipe = {
  readonly name: string;
  readonly description?: string;
  readonly orientation?: ContributorBundleOrientation;
  readonly leadPrompt: string;
  readonly specialists: ReadonlyArray<{
    readonly specialist: ThreadSpecialist & { readonly instructions: string };
    readonly title: string;
  }>;
};

export class TeamTemplateService extends Context.Service<
  TeamTemplateService,
  {
    readonly preview: (
      input: OrchestrationV2PreviewSpecialistTemplateInput,
    ) => Effect.Effect<
      OrchestrationV2PreviewSpecialistTemplateResult,
      OrchestrationV2PreviewSpecialistTemplateError
    >;
    readonly add: (
      input: OrchestrationV2AddSpecialistsFromTemplateInput,
    ) => Effect.Effect<
      OrchestrationV2AddSpecialistsFromTemplateResult,
      | OrchestrationV2AddSpecialistsFromTemplateError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/TeamTemplateService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const bundles = yield* ContributorBundleLoader.ContributorBundleLoader;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const requireProject = <E>(
    projectId: ProjectId,
    toError: (message: string, cause?: unknown) => E,
  ) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => toError("Unable to read the project for this template.", cause)),
      Effect.flatMap((value) =>
        Effect.fromOption(value).pipe(Effect.mapError(() => toError("Project not found."))),
      ),
    );

  const resolveBuiltinRecipe = (source: Extract<SpecialistTemplateSource, { kind: "builtin" }>) => {
    const template = teamTemplateById(source.templateId);
    return {
      name: template.name,
      description: template.description,
      leadPrompt: formatWorkshopLeadPrompt(template),
      specialists: template.seats.map((seat) => ({
        specialist: {
          key: seat.id,
          label: seat.title,
          instructions: seat.roleBrief,
        },
        title: seat.title,
      })),
    } satisfies ResolvedSpecialistRecipe;
  };

  const resolveContributorBundleRecipe = Effect.fn(
    "TeamTemplateService.resolveContributorBundleRecipe",
  )(function* <E>(projectWorkspaceRoot: string, toError: (message: string, cause?: unknown) => E) {
    const bundle = yield* bundles
      .load(projectWorkspaceRoot)
      .pipe(
        Effect.flatMap((value) =>
          Effect.fromOption(value).pipe(
            Effect.mapError(() =>
              toError(`No valid ${CONTRIBUTOR_BUNDLE_FILE_NAME} in this checkout.`),
            ),
          ),
        ),
      );

    return {
      name: bundle.name,
      ...(bundle.description === undefined ? {} : { description: bundle.description }),
      orientation: bundle.orientation,
      leadPrompt: formatContributorBundleLeadPrompt(bundle),
      specialists: bundle.seats.map((seat) => ({
        specialist: {
          key: seat.id,
          label: seat.title,
          instructions: formatContributorBundleSeatBrief(seat, bundle.orientation),
        },
        title: seat.title,
      })),
    } satisfies ResolvedSpecialistRecipe;
  });

  const resolveRecipe = <E>(
    projectWorkspaceRoot: string,
    source: SpecialistTemplateSource,
    toError: (message: string, cause?: unknown) => E,
  ): Effect.Effect<ResolvedSpecialistRecipe, E> => {
    if (source.kind === "builtin") {
      return Effect.succeed(resolveBuiltinRecipe(source));
    }
    return resolveContributorBundleRecipe(projectWorkspaceRoot, toError);
  };

  const existingSpecialistKeys = (projectId: ProjectId) =>
    threads.getShellSnapshot({ projectId }).pipe(
      Effect.map((snapshot) => {
        const keys = new Map<string, ThreadId>();
        for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
          if (thread.deletedAt !== null) continue;
          const key = thread.specialist?.key;
          if (key === undefined) continue;
          if (!keys.has(key)) keys.set(key, thread.id);
        }
        return keys;
      }),
    );

  const preview = Effect.fn("TeamTemplateService.preview")(function* (
    input: OrchestrationV2PreviewSpecialistTemplateInput,
  ) {
    const toError = (message: string, cause?: unknown) =>
      new OrchestrationV2PreviewSpecialistTemplateError({
        projectId: input.projectId,
        source: input.source,
        message,
        ...(cause === undefined ? {} : { cause }),
      });

    const project = yield* requireProject(input.projectId, toError);
    const recipe = yield* resolveRecipe(project.workspaceRoot, input.source, toError);
    const [lead, ...rest] = recipe.specialists;
    if (lead === undefined) {
      return yield* toError("Template produced no specialists.");
    }

    const boundKeys = yield* existingSpecialistKeys(input.projectId).pipe(
      Effect.mapError((cause) => toError("Unable to read existing specialists.", cause)),
    );

    return {
      source: input.source,
      name: recipe.name,
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      ...(recipe.orientation === undefined ? {} : { orientation: recipe.orientation }),
      leadPrompt: recipe.leadPrompt,
      specialists: [
        {
          key: lead.specialist.key,
          label: lead.specialist.label,
          instructions: lead.specialist.instructions,
          title: lead.title,
          ...(boundKeys.get(lead.specialist.key) === undefined
            ? {}
            : { existingThreadId: boundKeys.get(lead.specialist.key) }),
        },
        ...rest.map((entry) => ({
          key: entry.specialist.key,
          label: entry.specialist.label,
          instructions: entry.specialist.instructions,
          title: entry.title,
          ...(boundKeys.get(entry.specialist.key) === undefined
            ? {}
            : { existingThreadId: boundKeys.get(entry.specialist.key) }),
        })),
      ],
    } satisfies OrchestrationV2PreviewSpecialistTemplateResult;
  });

  const add = Effect.fn("TeamTemplateService.add")(function* (
    input: OrchestrationV2AddSpecialistsFromTemplateInput,
  ) {
    const toError = (message: string, cause?: unknown) =>
      new OrchestrationV2AddSpecialistsFromTemplateError({
        commandId: input.commandId,
        projectId: input.projectId,
        source: input.source,
        message,
        ...(cause === undefined ? {} : { cause }),
      });

    const project = yield* requireProject(input.projectId, toError);
    const recipe = yield* resolveRecipe(project.workspaceRoot, input.source, toError);
    const [leadRecipe, ...restRecipe] = recipe.specialists;
    if (leadRecipe === undefined) {
      return yield* toError("Template produced no specialists.");
    }

    const boundKeys = yield* existingSpecialistKeys(input.projectId).pipe(
      Effect.mapError((cause) => toError("Unable to read existing specialists.", cause)),
    );
    const conflicts = [leadRecipe, ...restRecipe]
      .map((entry) => entry.specialist.key)
      .filter((key) => boundKeys.has(key));
    if (conflicts.length > 0) {
      return yield* toError(
        `Specialist key${conflicts.length === 1 ? "" : "s"} already bound in this project: ${conflicts.map((key) => `"${key}"`).join(", ")}.`,
      );
    }

    const pin = input.pin !== false;
    const launched = yield* Effect.forEach(
      [leadRecipe, ...restRecipe],
      (entry, index) =>
        Effect.gen(function* () {
          const threadId = yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(
              Effect.mapError((cause) =>
                toError(`Unable to allocate a thread for ${entry.title}.`, cause),
              ),
            );
          yield* threads
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`${input.commandId}:specialist:${index}:create`),
              createdBy: "user",
              creationSource: "web",
              threadId,
              projectId: project.id,
              title: entry.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath: null,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? error
                  : toError(
                      `Unable to create ${entry.title}: ${error instanceof Error ? error.message : String(error)}`,
                      error,
                    ),
              ),
            );
          yield* threads
            .dispatch({
              type: "thread.specialist.set",
              commandId: CommandId.make(`${input.commandId}:specialist:${index}:bind`),
              threadId,
              specialist: entry.specialist,
            })
            .pipe(
              Effect.mapError((cause) =>
                toError(`Created ${entry.title}, but binding its specialist failed.`, cause),
              ),
            );
          if (pin) {
            yield* threads
              .dispatch({
                type: "thread.pin",
                commandId: CommandId.make(`${input.commandId}:specialist:${index}:pin`),
                threadId,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toError(`Created ${entry.title}, but pinning it failed.`, cause),
                ),
              );
          }
          return {
            specialist: entry.specialist,
            title: entry.title,
            threadId,
          };
        }),
      { concurrency: 1 },
    );

    const [lead, ...rest] = launched;
    if (lead === undefined) {
      return yield* toError("Template produced no specialists.");
    }

    return {
      source: input.source,
      name: recipe.name,
      leadPrompt: recipe.leadPrompt,
      specialists: [lead, ...rest],
    } satisfies OrchestrationV2AddSpecialistsFromTemplateResult;
  });

  return TeamTemplateService.of({ preview, add });
});

export const layer: Layer.Layer<
  TeamTemplateService,
  never,
  | ProjectService.ProjectService
  | ContributorBundleLoader.ContributorBundleLoader
  | IdAllocator.IdAllocatorV2
  | ThreadManagement.ThreadManagementService
> = Layer.effect(TeamTemplateService, make);
