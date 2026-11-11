import {
  CommandId,
  CONTRIBUTOR_BUNDLE_FILE_NAME,
  type OrchestrationV2InstallContributorBundleInput,
  type OrchestrationV2InstallContributorBundleResult,
  OrchestrationV2InstallContributorBundleError,
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

export class ContributorBundleService extends Context.Service<
  ContributorBundleService,
  {
    readonly install: (
      input: OrchestrationV2InstallContributorBundleInput,
    ) => Effect.Effect<
      OrchestrationV2InstallContributorBundleResult,
      | OrchestrationV2InstallContributorBundleError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ContributorBundleService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const bundles = yield* ContributorBundleLoader.ContributorBundleLoader;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const install = Effect.fn("ContributorBundleService.install")(function* (
    input: OrchestrationV2InstallContributorBundleInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2InstallContributorBundleError({
            commandId: input.commandId,
            projectId: input.projectId,
            message: "Unable to read the project for this contributor bundle.",
            cause,
          }),
      ),
      Effect.flatMap((value) =>
        Effect.fromOption(value).pipe(
          Effect.mapError(
            () =>
              new OrchestrationV2InstallContributorBundleError({
                commandId: input.commandId,
                projectId: input.projectId,
                message: "Project not found.",
              }),
          ),
        ),
      ),
    );

    const bundle = yield* bundles.load(project.workspaceRoot).pipe(
      Effect.flatMap((value) =>
        Effect.fromOption(value).pipe(
          Effect.mapError(
            () =>
              new OrchestrationV2InstallContributorBundleError({
                commandId: input.commandId,
                projectId: input.projectId,
                message: `No valid ${CONTRIBUTOR_BUNDLE_FILE_NAME} in this checkout.`,
              }),
          ),
        ),
      ),
    );

    const pin = input.pin !== false;
    const launched = yield* Effect.forEach(
      bundle.seats,
      (seat, index) =>
        Effect.gen(function* () {
          const threadId = yield* ids.allocate.thread({ projectId: input.projectId }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2InstallContributorBundleError({
                  commandId: input.commandId,
                  projectId: input.projectId,
                  message: `Unable to allocate a thread for ${seat.title}.`,
                  cause,
                }),
            ),
          );
          const createCommandId = CommandId.make(`${input.commandId}:seat:${index}:create`);
          yield* threads
            .dispatch({
              type: "thread.create",
              commandId: createCommandId,
              createdBy: "user",
              creationSource: "web",
              threadId,
              projectId: project.id,
              title: seat.title,
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
                  : new OrchestrationV2InstallContributorBundleError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: `Unable to create ${seat.title}: ${error instanceof Error ? error.message : String(error)}`,
                      cause: error,
                    }),
              ),
            );
          if (pin) {
            yield* threads
              .dispatch({
                type: "thread.pin",
                commandId: CommandId.make(`${input.commandId}:seat:${index}:pin`),
                threadId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2InstallContributorBundleError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      message: `Created ${seat.title}, but pinning it failed.`,
                      cause,
                    }),
                ),
              );
          }
          return {
            seatId: seat.id,
            title: seat.title,
            roleBrief: formatContributorBundleSeatBrief(seat, bundle.orientation),
            threadId,
          };
        }),
      { concurrency: 1 },
    );
    const [leadSeat, ...otherSeats] = launched;
    if (leadSeat === undefined) {
      return yield* new OrchestrationV2InstallContributorBundleError({
        commandId: input.commandId,
        projectId: input.projectId,
        message: "Contributor bundle produced no seats.",
      });
    }

    return {
      name: bundle.name,
      ...(bundle.description === undefined ? {} : { description: bundle.description }),
      orientation: bundle.orientation,
      leadPrompt: formatContributorBundleLeadPrompt(bundle),
      seats: [leadSeat, ...otherSeats],
    } satisfies OrchestrationV2InstallContributorBundleResult;
  });

  return ContributorBundleService.of({ install });
});

export const layer: Layer.Layer<
  ContributorBundleService,
  never,
  | ProjectService.ProjectService
  | ContributorBundleLoader.ContributorBundleLoader
  | IdAllocator.IdAllocatorV2
  | ThreadManagement.ThreadManagementService
> = Layer.effect(ContributorBundleService, make);
