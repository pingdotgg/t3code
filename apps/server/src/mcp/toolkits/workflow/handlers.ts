import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as Workflows from "../../../workflows/Workflows.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
        if (input.action === "questions") {
          const questions = yield* workflows.questions.pipe(Effect.mapError(refused));
          return {
            questions:
              input.kind === undefined
                ? questions
                : questions.filter((question) => question.kind === input.kind),
          };
        }
        if (input.action === "store") {
          return {
            entries: yield* workflows.stored(input.key ?? "").pipe(Effect.mapError(refused)),
          };
        }
        if (input.action === "list") {
          return {
            runs: yield* workflows
              .list({
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.tag === undefined ? {} : { tag: input.tag }),
                ...(input.subject === undefined ? {} : { subject: input.subject }),
              })
              .pipe(Effect.mapError(refused)),
          };
        }
        const runId = yield* required(input.runId, "runId");
        return yield* workflows.get(runId).pipe(Effect.mapError(refused));
      }),
    ),
    McpToolAccess.writesOwnerWork("start or change workflow runs, or read hook paths", (input) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // A hook's path holds its secret, and posting to it starts a run.
        if (input.action === "hooks") {
          return { hooks: yield* workflows.hooks.pipe(Effect.mapError(refused)) };
        }
        if (input.action === "start") {
          const name = yield* required(input.workflow, "workflow");
          const idempotencyKey = yield* required(input.idempotencyKey, "idempotencyKey");
          const { runId } = yield* workflows
            .start(name, input.input === undefined ? {} : input.input, { idempotencyKey })
            .pipe(Effect.mapError(refused));
          return yield* workflows.get(runId).pipe(Effect.mapError(refused));
        }
        if (input.action === "signal") {
          const value = yield* required(input.value, "value");
          const byRun = input.runId !== undefined || input.wait !== undefined;
          const byChannel = input.workflow !== undefined || input.channel !== undefined;
          if (byRun && byChannel) {
            return yield* invalid(
              "Address a signal with `runId` and `wait`, or with `workflow` and `channel`, not both.",
            );
          }
          const address =
            input.runId !== undefined && input.wait !== undefined
              ? { runId: input.runId, wait: input.wait }
              : input.workflow !== undefined && input.channel !== undefined
                ? { workflow: input.workflow, channel: input.channel }
                : undefined;
          if (address === undefined) {
            return yield* invalid(
              "Address a signal with `runId` and `wait`, or `workflow` and `channel`.",
            );
          }
          const random = yield* SecureRandom.SecureRandom;
          const id = input.signalId ?? (yield* random.uuidV4());
          // The server refuses a thread's call to this tool, so the caller is a client. An agent
          // answers through the CLI, a client it names after its thread.
          const answeredBy = (yield* McpInvocationContext.McpInvocationContext).client?.label;
          const delivery = yield* workflows
            .signal(address, value, { id, ...(answeredBy === undefined ? {} : { answeredBy }) })
            .pipe(Effect.mapError(refused));
          return { delivery };
        }
        if (input.action === "withdraw") {
          const runId = yield* required(input.runId, "runId");
          const wait = yield* required(input.wait, "wait");
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const by =
            scope.thread !== undefined
              ? `thread ${scope.thread.threadId}`
              : (scope.client?.label ?? "a person");
          const withdrawal = yield* workflows
            .withdraw(runId, wait, { by, reason: input.reason })
            .pipe(Effect.mapError(refused));
          return { withdrawal, ...(yield* workflows.get(runId).pipe(Effect.mapError(refused))) };
        }
        if (input.action === "store_set" || input.action === "store_delete") {
          const key = yield* required(input.key, "key");
          const value =
            input.action === "store_set" ? yield* required(input.value, "value") : undefined;
          yield* (
            value === undefined ? workflows.storeDelete(key) : workflows.storeSet(key, value)
          ).pipe(Effect.mapError(refused));
          return { entries: yield* workflows.stored(key).pipe(Effect.mapError(refused)) };
        }
        const runId = yield* required(input.runId, "runId");
        yield* (
          input.action === "resume"
            ? workflows.resume(runId)
            : workflows.cancel(runId, input.reason)
        ).pipe(Effect.mapError(refused));
        return yield* workflows.get(runId).pipe(Effect.mapError(refused));
      }),
    ),
  ),
});
