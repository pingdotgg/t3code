import { ProjectMutationError, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectService from "../project/ProjectService.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

export const dispatchClientCommand = Effect.fn("orchestrationV2.dispatchClientCommand")(
  function* (input: {
    readonly command: OrchestrationV2Command;
    readonly projects: ProjectService.ProjectService["Service"];
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
  }) {
    const command = input.command;
    if (command.type !== "thread.create") {
      return yield* input.threads.dispatch(command);
    }
    return yield* input.threads.withProjectCreationAdmission(
      { projectId: command.projectId, commandId: command.commandId },
      (receipt) =>
        Effect.gen(function* () {
          if (Option.isNone(receipt)) {
            const project = yield* input.projects.getById(command.projectId);
            if (Option.isNone(project)) {
              return yield* new ProjectMutationError({
                commandId: command.commandId,
                message: `Project ${command.projectId} does not exist.`,
              });
            }
          }
          return yield* input.threads.dispatch(command);
        }),
    );
  },
);
