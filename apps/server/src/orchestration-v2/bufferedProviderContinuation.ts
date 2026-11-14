import type {
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Buffered output drains on the session that produced it, on the selection that session last ran. */
export function resolveBufferedProviderContinuation<
  ProviderThread extends Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "id">,
>(
  projection: {
    readonly providerThreads: ReadonlyArray<ProviderThread>;
    readonly runs: ReadonlyArray<
      Pick<
        OrchestrationV2ThreadProjection["runs"][number],
        "providerThreadId" | "startedAt" | "modelSelection"
      >
    >;
  },
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
) {
  if (
    command.continuationProviderThreadId === undefined ||
    command.createdBy !== "agent" ||
    command.creationSource !== "provider" ||
    command.notification === undefined
  ) {
    return undefined;
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === command.continuationProviderThreadId,
  );
  const modelSelection = projection.runs.findLast(
    // A send queued on this thread and never started names a model the session never ran.
    (run) => run.providerThreadId === providerThread?.id && run.startedAt !== null,
  )?.modelSelection;
  return providerThread === undefined || modelSelection === undefined
    ? undefined
    : { providerThread, modelSelection };
}
