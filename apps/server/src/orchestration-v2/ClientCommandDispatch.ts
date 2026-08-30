import { ProjectMutationError, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  return Effect.fn("orchestrationV2.dispatchClientCommand")(function* (
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
});
