import { EnvironmentId, ProviderInstanceId, SubAgentError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { makeWorkflowEngine, type WorkflowTaskHandlers } from "../workflows/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../workflows/WorkflowSchema.ts";

const context = {
  workflowId: "test-wf-123",
  callerThreadId: ThreadId.make("thread-123"),
  callerProviderInstanceId: ProviderInstanceId.make("codex"),
  environmentId: EnvironmentId.make("local"),
  variables: new Map([
    ["query", "test query"],
    ["a+b", "literal replacement"],
  ]),
};

const successfulHandlers = (): WorkflowTaskHandlers<never> => ({
  spawn: (_context, input) =>
    Effect.succeed({
      threadId: ThreadId.make(`thread-${input.prompt.replace(/\s+/g, "-")}`),
      providerInstanceId: input.providerInstanceId,
      model: input.model ?? "default-model",
      title: input.prompt,
      status: "running",
    }),
  send: (_context, input) =>
    Effect.succeed({
      threadId: input.threadId,
      status: "running",
    }),
  wait: (_context, input) =>
    Effect.succeed({
      threadId: input.threadId,
      status: "completed",
      finalText: "finished",
      stalled: false,
    }),
});

const workflow = (tasks: WorkflowDefinition["phases"][number]["tasks"]): WorkflowDefinition => ({
  name: "test-workflow",
  description: "Workflow engine runtime test",
  version: "1.0.0",
  phases: [
    {
      id: "phase",
      title: "Test phase",
      execution: "sequential",
      tasks,
    },
  ],
});

describe("WorkflowEngine", () => {
  it.effect("executes tasks in order and replaces literal placeholders", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) => {
          prompts.push(input.prompt);
          return handlers.spawn(toolContext, input);
        },
      });

      const result = yield* engine.execute(
        workflow([
          {
            id: "first",
            type: "spawn",
            provider: ProviderInstanceId.make("codex"),
            prompt: "Search {{query}} and {{a+b}}",
          },
          {
            id: "second",
            type: "spawn",
            provider: ProviderInstanceId.make("codex"),
            prompt: "Second",
            dependencies: ["first"],
          },
        ]),
        context,
      );

      expect(result.status).toBe("completed");
      expect(result.phases[0]?.tasks.map((task) => task.taskId)).toEqual(["first", "second"]);
      expect(prompts).toEqual(["Search test query and literal replacement", "Second"]);
    }),
  );

  it.effect("runs dependency-ready parallel batches within parallelismLimit", () =>
    Effect.gen(function* () {
      let active = 0;
      let maxActive = 0;
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) =>
          Effect.gen(function* () {
            active += 1;
            maxActive = Math.max(maxActive, active);
            yield* Effect.yieldNow;
            active -= 1;
            return yield* handlers.spawn(toolContext, input);
          }),
      });

      const definition: WorkflowDefinition = {
        ...workflow([]),
        parallelismLimit: 1,
        phases: [
          {
            id: "parallel",
            title: "Parallel",
            execution: "parallel",
            tasks: [
              {
                id: "first",
                type: "spawn",
                provider: ProviderInstanceId.make("codex"),
                prompt: "First",
              },
              {
                id: "second",
                type: "spawn",
                provider: ProviderInstanceId.make("codex"),
                prompt: "Second",
              },
              {
                id: "after-first",
                type: "wait",
                dependencies: ["first"],
              },
            ],
          },
        ],
      };

      const result = yield* engine.execute(definition, context);

      expect(maxActive).toBe(1);
      expect(result.phases[0]?.tasks.map((task) => task.taskId)).toEqual([
        "first",
        "second",
        "after-first",
      ]);
    }),
  );

  it.effect("retries failed tasks with the configured policy", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) => {
          attempts += 1;
          return attempts < 3
            ? new SubAgentError({
                reason: "dispatch-failed",
                description: "temporary failure",
              })
            : handlers.spawn(toolContext, input);
        },
      });

      const result = yield* engine.execute(
        workflow([
          {
            id: "retry",
            type: "spawn",
            provider: ProviderInstanceId.make("codex"),
            prompt: "Retry",
            onError: "retry",
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
          },
        ]),
        context,
      );

      expect(attempts).toBe(3);
      expect(result.status).toBe("completed");
    }),
  );

  it.effect("continues after a recoverable task failure", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) => {
          prompts.push(input.prompt);
          return input.prompt === "Fail"
            ? new SubAgentError({ reason: "dispatch-failed", description: "failed" })
            : handlers.spawn(toolContext, input);
        },
      });

      const result = yield* engine.execute(
        workflow([
          {
            id: "failed",
            type: "spawn",
            provider: ProviderInstanceId.make("codex"),
            prompt: "Fail",
            onError: "continue",
          },
          {
            id: "continued",
            type: "spawn",
            provider: ProviderInstanceId.make("codex"),
            prompt: "Continue",
          },
        ]),
        context,
      );

      expect(prompts).toEqual(["Fail", "Continue"]);
      expect(result.status).toBe("failed");
      expect(result.phases[0]?.tasks.map((task) => task.status)).toEqual(["failed", "completed"]);
    }),
  );

  it.effect("continues into later phases after a recoverable task failure", () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) => {
          prompts.push(input.prompt);
          return input.prompt === "Fail"
            ? new SubAgentError({ reason: "dispatch-failed", description: "failed" })
            : handlers.spawn(toolContext, input);
        },
      });
      const definition: WorkflowDefinition = {
        ...workflow([]),
        phases: [
          {
            id: "recoverable",
            title: "Recoverable failure",
            execution: "sequential",
            tasks: [
              {
                id: "failed",
                type: "spawn",
                provider: ProviderInstanceId.make("codex"),
                prompt: "Fail",
                onError: "continue",
              },
            ],
          },
          {
            id: "later",
            title: "Later phase",
            execution: "sequential",
            tasks: [
              {
                id: "later-task",
                type: "spawn",
                provider: ProviderInstanceId.make("codex"),
                prompt: "Later",
              },
            ],
          },
        ],
      };

      const result = yield* engine.execute(definition, context);

      expect(prompts).toEqual(["Fail", "Later"]);
      expect(result.status).toBe("failed");
      expect(result.phases.map((phase) => phase.phaseId)).toEqual(["recoverable", "later"]);
    }),
  );

  it.effect("rejects duplicate task IDs before executing handlers", () =>
    Effect.gen(function* () {
      let spawnCalls = 0;
      const handlers = successfulHandlers();
      const engine = makeWorkflowEngine({
        ...handlers,
        spawn: (toolContext, input) => {
          spawnCalls += 1;
          return handlers.spawn(toolContext, input);
        },
      });
      const duplicateTask = {
        id: "duplicate",
        type: "spawn" as const,
        provider: ProviderInstanceId.make("codex"),
        prompt: "Duplicate",
      };
      const definition: WorkflowDefinition = {
        ...workflow([]),
        phases: [
          {
            id: "first-phase",
            title: "First phase",
            execution: "sequential",
            tasks: [duplicateTask],
          },
          {
            id: "second-phase",
            title: "Second phase",
            execution: "sequential",
            tasks: [duplicateTask],
          },
        ],
      };

      const exit = yield* engine.execute(definition, context).pipe(Effect.exit);

      expect(spawnCalls).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "INVALID_WORKFLOW",
          message: "Workflow test-workflow contains duplicate task ID: duplicate",
        });
      }
    }),
  );

  it.effect("propagates aborting task failures", () =>
    Effect.gen(function* () {
      const engine = makeWorkflowEngine({
        ...successfulHandlers(),
        spawn: () =>
          new SubAgentError({
            reason: "dispatch-failed",
            description: "permanent failure",
          }),
      });

      const exit = yield* engine
        .execute(
          workflow([
            {
              id: "abort",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Abort",
            },
          ]),
          context,
        )
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          message: "Task abort failed: permanent failure",
        });
      }
    }),
  );

  it.effect("interrupts an active task and returns cancelled", () =>
    Effect.gen(function* () {
      const engine = makeWorkflowEngine({
        ...successfulHandlers(),
        spawn: () => Effect.never,
      });

      const fiber = yield* engine
        .execute(
          workflow([
            {
              id: "long-running",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Long running",
            },
          ]),
          context,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* engine.cancel(context.workflowId);
      const result = yield* Fiber.join(fiber);

      expect(result.status).toBe("cancelled");
    }),
  );
});
