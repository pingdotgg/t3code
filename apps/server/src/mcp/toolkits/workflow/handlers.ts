import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WORKFLOW_READ_ACTIONS, WorkflowToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${name}\`.`))
    : Effect.succeed(value);
const refused = (error: Workflows.WorkflowError) => invalid(error.message);
const isRead = (action: string): action is (typeof WORKFLOW_READ_ACTIONS)[number] =>
  (WORKFLOW_READ_ACTIONS as ReadonlyArray<string>).includes(action);

export const layer = McpToolAccess.toLayer(WorkflowToolkit, {
  t3_workflow: McpToolAccess.either(
    (input) => isRead(input.action),
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        if (input.action === "questions") return { questions: yield* workflows.questions };
        if (input.action === "hooks") return { hooks: yield* workflows.hooks };
        if (input.action === "list") {
          return {
            runs: yield* workflows.list(input.status === undefined ? {} : { status: input.status }),
          };
        }
        const runId = yield* required(input.runId, "runId");
        return yield* workflows.get(runId).pipe(Effect.mapError(refused));
      }),
    ),
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        if (input.action === "start") {
          const name = yield* required(input.workflow, "workflow");
          const idempotencyKey = yield* required(input.idempotencyKey, "idempotencyKey");
          const { runId } = yield* workflows
            .start(name, input.input ?? {}, { idempotencyKey })
            .pipe(Effect.mapError(refused));
          return yield* workflows.get(runId).pipe(Effect.mapError(refused));
        }
        if (input.action === "signal") {
          const value = yield* required(input.value, "value");
          const address =
            input.runId !== undefined && input.wait !== undefined
              ? { runId: input.runId, wait: input.wait }
              : input.workflow !== undefined && input.key !== undefined
                ? { workflow: input.workflow, key: input.key }
                : undefined;
          if (address === undefined) {
            return yield* invalid(
              "Address a signal with `runId` and `wait`, or `workflow` and `key`.",
            );
          }
          const random = yield* SecureRandom.SecureRandom;
          const id = input.signalId ?? (yield* random.uuidV4());
          const delivery = yield* workflows
            .signal(address, value, { id })
            .pipe(Effect.mapError(refused));
          return { delivery };
        }
        const runId = yield* required(input.runId, "runId");
        yield* (
          input.action === "resume"
            ? workflows.resume(runId)
            : workflows.cancel(runId, input.reason ?? "Cancelled")
        ).pipe(Effect.mapError(refused));
        return yield* workflows.get(runId).pipe(Effect.mapError(refused));
      }),
    ),
  ),
});
