import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * One durable task that stays active long enough for `instance.pause()` to
 * land while `step.do` is still running. When the task then finishes, the
 * local Workflow engine rejects with Cloudflare's pause control-flow error;
 * `WorkflowBridge` must preserve that rejection so status becomes `paused`.
 */
export default class PauseWorkflow extends Cloudflare.Workflow<PauseWorkflow>()(
  "PauseWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (_input: { value: string }) {
      yield* Cloudflare.Workflows.task(
        "slow",
        Effect.gen(function* () {
          yield* Effect.sleep("8 seconds");
          return "done";
        }),
      );
      return { ok: true };
    });
  }),
) {}
