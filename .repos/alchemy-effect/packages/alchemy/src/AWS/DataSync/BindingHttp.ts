import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Task } from "./Task.ts";

/**
 * Shared scaffolding for AWS DataSync HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action is
 * boilerplate.
 *
 * DataSync authorizes task-addressed actions against the *task* ARN
 * (`arn:…:task/task-id`) and execution-addressed actions against the
 * *task execution* ARN (`arn:…:task/task-id/execution/exec-id`), so every
 * builder grants on both the bound task's ARN and its execution pattern.
 */
const taskPolicyStatement = (task: Task, actions: readonly string[]) => ({
  Effect: "Allow" as const,
  Action: [...actions],
  Resource: [
    Output.interpolate`${task.taskArn}`,
    Output.map(task.taskArn, (arn) => `${arn}/execution/*`),
  ],
});

/**
 * Build the impl Effect for an operation whose input carries a `TaskArn`
 * field: the runtime callable injects the bound {@link Task}'s ARN and the
 * deploy-time half grants `actions` on the task ARN (and its execution
 * pattern).
 */
export const makeDataSyncTaskHttpBinding = <
  I extends { TaskArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DataSync.StartTaskExecution`. */
  tag: string;
  /** The distilled operation; `TaskArn` is injected from the task. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the task ARN + execution pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (task: Task) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const TaskArn = yield* task.taskArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${task}))`({
            policyStatements: [taskPolicyStatement(task, options.actions)],
          });
        }
      }
      return Effect.fn(`${options.tag}(${task.LogicalId})`)(function* (
        request?: Omit<I, "TaskArn">,
      ) {
        return yield* op({ ...request, TaskArn: yield* TaskArn } as I);
      });
    });
  });

/**
 * Build the impl Effect for a task-anchored operation whose input addresses
 * a task *execution* by ARN (returned by `StartTaskExecution`): the request
 * passes through as-is and the deploy-time half grants `actions` on the
 * bound task's ARN + execution pattern.
 */
export const makeDataSyncTaskExecutionHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DataSync.CancelTaskExecution`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the task ARN + execution pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (task: Task) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${task}))`({
            policyStatements: [taskPolicyStatement(task, options.actions)],
          });
        }
      }
      return Effect.fn(`${options.tag}(${task.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
