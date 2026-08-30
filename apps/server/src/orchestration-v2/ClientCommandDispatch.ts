import { ProjectMutationError, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import type { CommandReceiptStoreV2Error } from "./CommandReceiptStore.ts";
import type { OrchestratorV2DispatchResult, OrchestratorV2Error } from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ClientCommandDispatch extends Context.Service<
  ClientCommandDispatch,
  {
    readonly dispatch: (
      command: OrchestrationV2Command,
    ) => Effect.Effect<
      OrchestratorV2DispatchResult,
      | ProjectMutationError
      | ProjectService.ProjectOperationError
      | CommandReceiptStoreV2Error
      | OrchestratorV2Error
    >;
  }
>()("t3/orchestration-v2/ClientCommandDispatch") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const dispatch = Effect.fn("orchestrationV2.dispatchClientCommand")(function* (
    command: OrchestrationV2Command,
  ) {
    if (command.type !== "thread.create") {
      return yield* threads.dispatch(command);
    }
    return yield* threads.withProjectCreationAdmission(
      { projectId: command.projectId, commandId: command.commandId },
      (receipt) =>
        Effect.gen(function* () {
          if (Option.isNone(receipt)) {
            const project = yield* projects.getById(command.projectId);
            if (Option.isNone(project)) {
              return yield* new ProjectMutationError({
                commandId: command.commandId,
                message: `Project ${command.projectId} does not exist.`,
              });
            }
          }
          return yield* threads.dispatch(command);
        }),
    );
  });

  return ClientCommandDispatch.of({ dispatch });
});

export const layer = Layer.effect(ClientCommandDispatch, make);
