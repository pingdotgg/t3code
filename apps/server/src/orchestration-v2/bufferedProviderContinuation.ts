import type {
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function resolveBufferedProviderContinuation(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "runs">,
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
) {
  if (
    command.continuationProviderThreadId === undefined ||
    command.createdBy !== "agent" ||
    command.creationSource !== "provider" ||
    command.notification === undefined ||
    command.freshContext === true
  ) {
    return undefined;
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === command.continuationProviderThreadId,
  );
  const modelSelection = projection.runs.findLast(
    (run) => run.providerThreadId === providerThread?.id,
  )?.modelSelection;
  return providerThread === undefined || modelSelection === undefined
    ? undefined
    : { providerThread, modelSelection };
}
