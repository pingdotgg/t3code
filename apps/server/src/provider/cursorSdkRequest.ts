import { Agent, type AgentOptions, type Run, type RunResult, type SDKAgent } from "@cursor/sdk";
import * as Effect from "effect/Effect";

interface CursorSdkRequest {
  readonly result: Promise<RunResult>;
  readonly cancel: () => void;
}

/**
 * Own the Cursor SDK objects beyond the caller's deadline. Cursor's promises
 * do not accept an AbortSignal, so cancellation is requested without awaiting
 * it and the result settles only after an acquired run and agent settle.
 */
export function runCursorSdkRequest(input: {
  readonly agentOptions: AgentOptions;
  readonly prompt: string;
}): CursorSdkRequest {
  let cancellationRequested = false;
  let run: Run | undefined;
  let runWait: Promise<RunResult> | undefined;
  let cancellation: Promise<void> | undefined;

  const cancelRun = () => {
    if (run === undefined || cancellation !== undefined) return;
    cancellation = (async () => {
      const cancel =
        run.status === "running" && run.supports("cancel") ? run.cancel() : Promise.resolve();
      const wait = runWait ?? (run.supports("wait") ? run.wait() : Promise.resolve(undefined));
      await Promise.allSettled([cancel, wait]);
    })();
  };

  const result = (async () => {
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.create(input.agentOptions);
      if (cancellationRequested) {
        throw new Error("Cursor SDK request was cancelled before sending.");
      }
      run = await agent.send(input.prompt);
      runWait = run.wait();
      if (cancellationRequested) {
        cancelRun();
        await cancellation;
      }
      return await runWait;
    } finally {
      if (cancellationRequested) {
        cancelRun();
        await cancellation?.catch(() => undefined);
      }
      if (agent !== undefined) {
        await Promise.resolve(agent[Symbol.asyncDispose]()).catch(() => undefined);
      }
    }
  })();
  // The owner starts eagerly, before the Effect fiber attaches its handler.
  // Observe early failures here while returning the original promise to Effect.
  void result.catch(() => undefined);

  return {
    result,
    cancel: () => {
      cancellationRequested = true;
      cancelRun();
    },
  };
}

/**
 * Bridge late SDK settlement back into application cleanup after its owning
 * scope has closed. Cursor cannot abort acquisition or disposal promises; the
 * workspace must remain until those promises settle, even after interruption.
 */
export const cleanupCursorSdkRequestAfterSettlement = Effect.fn(
  "cleanupCursorSdkRequestAfterSettlement",
)(function* (input: { readonly request: CursorSdkRequest; readonly cleanup: Effect.Effect<void> }) {
  const runCleanup = Effect.runPromiseWith(yield* Effect.context<never>());
  input.request.cancel();
  void input.request.result
    .catch(() => undefined)
    .then(() => runCleanup(input.cleanup))
    .catch(() => undefined);
});
