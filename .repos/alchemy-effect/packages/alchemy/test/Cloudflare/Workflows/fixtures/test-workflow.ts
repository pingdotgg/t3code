import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

export const RollbackResults = Cloudflare.R2.Bucket("WorkflowRollbackResults", {
  forceDestroy: true,
});

export const rollbackConfigs = {
  undefined: { retries: undefined, timeout: undefined },
  both: { retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" },
  "timeout-only": { timeout: "30 seconds", retries: undefined },
  "retries-only": {
    retries: { limit: 1, delay: "1 second" },
    timeout: undefined,
  },
} satisfies Record<string, Cloudflare.Workflows.WorkflowStepConfig>;

export const failureScenarios = [
  "timeout-zero",
  "rollback-timeout-zero",
  "retry-exhaustion",
  "rollback-retry-exhaustion",
] as const;

/** Workflow fixture exercised against local workerd and live Cloudflare. */
export default class LocalTestWorkflow extends Cloudflare.Workflow<LocalTestWorkflow>()(
  "LocalTestWorkflow",
  Effect.gen(function* () {
    const bucket = yield* RollbackResults;
    const results = yield* Cloudflare.R2.ReadWriteBucket(bucket);

    return Effect.fn(function* (input: {
      value: string;
      ready?: boolean;
      rollback?: boolean;
      scenario?: (typeof failureScenarios)[number];
    }) {
      if (input.ready) return { ready: true };
      const event = yield* Cloudflare.Workflows.WorkflowEvent;
      const triggerRollback = Cloudflare.Workflows.task(
        "fail-after-reservation",
        Effect.fail(new Error("rollback requested")),
        { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" },
      );

      if (
        input.scenario === "timeout-zero" ||
        input.scenario === "rollback-timeout-zero"
      ) {
        const protectedEffect = results
          .put(
            `${event.instanceId}/protected`,
            JSON.stringify({ executed: true }),
          )
          .pipe(Effect.asVoid, Effect.orDie);
        yield* Cloudflare.Workflows.task(
          "zero-timeout",
          input.scenario === "timeout-zero" ? protectedEffect : Effect.void,
          input.scenario === "timeout-zero"
            ? { timeout: 0 }
            : {
                rollback: () => protectedEffect,
                rollbackConfig: { timeout: 0 },
              },
        );
        yield* triggerRollback;
      }

      if (input.scenario === "retry-exhaustion") {
        yield* Cloudflare.Workflows.task(
          "exhaust-retries",
          Effect.gen(function* () {
            const { attempt } = yield* Cloudflare.Workflows.WorkflowStepContext;
            yield* results
              .put(`${event.instanceId}/attempts`, JSON.stringify({ attempt }))
              .pipe(Effect.orDie);
            return yield* Effect.fail(new Error("retry budget exhausted"));
          }),
          { retries: { limit: 1, delay: "1 second", backoff: "constant" } },
        );
      }

      if (input.scenario === "rollback-retry-exhaustion") {
        yield* Cloudflare.Workflows.task(
          "reserve-before-exhaustion",
          Effect.succeed({ value: input.value }),
          {
            rollbackConfig: {
              retries: { limit: 1, delay: "1 second", backoff: "constant" },
              timeout: undefined,
            },
            rollback: () =>
              Effect.gen(function* () {
                const key = `${event.instanceId}/attempts`;
                const object = yield* results.get(key);
                const previous = object
                  ? yield* object.json<{ attempt: number }>()
                  : { attempt: 0 };
                yield* results.put(
                  key,
                  JSON.stringify({ attempt: previous.attempt + 1 }),
                );
                return yield* Effect.fail(
                  new Error("rollback budget exhausted"),
                );
              }),
          },
        );
        yield* triggerRollback;
      }

      if (input.rollback) {
        for (const [name, rollbackConfig] of Object.entries(rollbackConfigs)) {
          yield* Cloudflare.Workflows.task(
            name,
            Effect.succeed({ value: input.value, step: name }),
            {
              rollbackConfig,
              rollback: ({ output, error }) =>
                results
                  .put(
                    `${event.instanceId}/${name}`,
                    JSON.stringify({ output, error: error.message }),
                  )
                  .pipe(Effect.asVoid, Effect.orDie),
            },
          );
        }
        yield* triggerRollback;
      }

      const greeted = yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({ text: `Hello, ${input.value}!` }),
      );

      const retried = yield* Cloudflare.Workflows.task(
        "retry-only",
        Effect.gen(function* () {
          const { attempt, config } =
            yield* Cloudflare.Workflows.WorkflowStepContext;
          if (attempt === 1) return yield* Effect.fail(new Error("retry once"));
          return { attempt, config };
        }),
        { retries: { limit: 2, delay: "1 second", backoff: "constant" } },
      );

      const bounded = yield* Cloudflare.Workflows.task(
        "timeout-only",
        Effect.gen(function* () {
          const { config } = yield* Cloudflare.Workflows.WorkflowStepContext;
          return config;
        }),
        { timeout: "30 seconds" },
      );

      const defaults = yield* Cloudflare.Workflows.task(
        "undefined-config",
        Effect.succeed({ ok: true }),
        { retries: undefined, timeout: undefined },
      );

      yield* Cloudflare.Workflows.sleep("cooldown", "1 second");

      return {
        greeting: greeted.text,
        retryAttempt: retried.attempt,
        retryConfig: retried.config,
        timeoutConfig: bounded,
        defaultsOk: defaults.ok,
        workflowName: event.workflowName,
        instanceId: event.instanceId,
      };
    });
  }),
) {}
