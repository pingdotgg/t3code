import {
  CommandId,
  type OrchestrationV2LaunchTeamTemplateInput,
  type OrchestrationV2LaunchTeamTemplateResult,
  OrchestrationV2LaunchTeamTemplateError,
  teamTemplateById,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class TeamTemplateService extends Context.Service<
  TeamTemplateService,
  {
    readonly launch: (
      input: OrchestrationV2LaunchTeamTemplateInput,
    ) => Effect.Effect<
      OrchestrationV2LaunchTeamTemplateResult,
      | OrchestrationV2LaunchTeamTemplateError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/TeamTemplateService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const launch = Effect.fn("TeamTemplateService.launch")(function* (
    input: OrchestrationV2LaunchTeamTemplateInput,
  ) {
    const template = teamTemplateById(input.templateId);
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2LaunchTeamTemplateError({
            commandId: input.commandId,
            projectId: input.projectId,
            templateId: input.templateId,
            message: "Unable to read the project for this team template.",
            cause,
          }),
      ),
      Effect.flatMap((value) =>
        Effect.fromOption(value).pipe(
          Effect.mapError(
            () =>
              new OrchestrationV2LaunchTeamTemplateError({
                commandId: input.commandId,
                projectId: input.projectId,
                templateId: input.templateId,
                message: "Project not found.",
              }),
          ),
        ),
      ),
    );

    const pin = input.pin !== false;
    const launched = yield* Effect.forEach(
      template.seats,
      (seat, index) =>
        Effect.gen(function* () {
          const threadId = yield* ids.allocate.thread({ projectId: input.projectId }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2LaunchTeamTemplateError({
                  commandId: input.commandId,
                  projectId: input.projectId,
                  templateId: input.templateId,
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
                  : new OrchestrationV2LaunchTeamTemplateError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      templateId: input.templateId,
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
                    new OrchestrationV2LaunchTeamTemplateError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      templateId: input.templateId,
                      message: `Created ${seat.title}, but pinning it failed.`,
                      cause,
                    }),
                ),
              );
          }
          return {
            seatId: seat.id,
            title: seat.title,
            roleBrief: seat.roleBrief,
            threadId,
          };
        }),
      { concurrency: 1 },
    );
    const [leadSeat, ...otherSeats] = launched;
    if (leadSeat === undefined) {
      return yield* new OrchestrationV2LaunchTeamTemplateError({
        commandId: input.commandId,
        projectId: input.projectId,
        templateId: input.templateId,
        message: "Team template produced no seats.",
      });
    }

    return {
      templateId: template.id,
      seats: [leadSeat, ...otherSeats],
    } satisfies OrchestrationV2LaunchTeamTemplateResult;
  });

  return TeamTemplateService.of({ launch });
});

export const layer: Layer.Layer<
  TeamTemplateService,
  never,
  | ProjectService.ProjectService
  | IdAllocator.IdAllocatorV2
  | ThreadManagement.ThreadManagementService
> = Layer.effect(TeamTemplateService, make);
