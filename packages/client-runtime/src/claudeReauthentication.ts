import type { OrchestrationV2ThreadProjection, ServerProvider } from "@t3tools/contracts";

export interface ClaudeReauthenticationTarget {
  readonly threadId: OrchestrationV2ThreadProjection["thread"]["id"];
  readonly instanceId: OrchestrationV2ThreadProjection["runs"][number]["providerInstanceId"];
  readonly runId: OrchestrationV2ThreadProjection["runs"][number]["id"];
  readonly message: string;
}

/** Offers login only for the current failed Claude run, never an older timeline error. */
export function getClaudeReauthenticationTarget(
  projection: OrchestrationV2ThreadProjection | null,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "enabled">>,
): ClaudeReauthenticationTarget | null {
  if (projection === null) return null;
  const { thread } = projection;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  const latestRun = projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (
    latestRun?.status !== "failed" ||
    projection.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    latestRun.providerInstanceId !== thread.providerInstanceId ||
    !providers.some(
      (provider) =>
        provider.instanceId === latestRun.providerInstanceId &&
        provider.driver === "claudeAgent" &&
        provider.enabled,
    )
  ) {
    return null;
  }
  let failure: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  for (const item of projection.turnItems) {
    if (
      item.runId === latestRun.id &&
      item.nodeId === latestRun.rootNodeId &&
      item.type === "error" &&
      (failure === undefined || item.ordinal > failure.ordinal)
    ) {
      failure = item;
    }
  }
  if (failure?.type !== "error" || failure.failure.class !== "auth_error") return null;
  return {
    threadId: thread.id,
    instanceId: latestRun.providerInstanceId,
    runId: latestRun.id,
    message: failure.failure.message,
  };
}
