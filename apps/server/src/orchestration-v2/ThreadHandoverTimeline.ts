import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/**
 * Deterministic handover timeline: partitions a thread's runs into user-anchored epochs, ranks
 * them for a successor agent, and renders a markdown summary that inlines full reports only
 * where they matter (the first and latest epochs).
 */

const detailPriorities = ["essential", "high"] as const;

export function buildThreadHandoverTimeline(projection: OrchestrationV2ThreadProjection) {
  if (projection.runs.length === 0) {
    return { epochs: [] as ReturnType<typeof buildEpochs>, markdown: "" };
  }
  const epochs = buildEpochs(projection);
  return { epochs, markdown: renderMarkdown(epochs) };
}

function buildEpochs(projection: OrchestrationV2ThreadProjection) {
  const runs = [...projection.runs].sort((a, b) => a.ordinal - b.ordinal);
  const messageById = new Map(projection.messages.map((message) => [message.id, message]));
  const isUserAnchored = (run: (typeof runs)[number]) =>
    messageById.get(run.userMessageId)?.createdBy === "user";

  const epochRunGroups: Array<Array<(typeof runs)[number]>> = [];
  for (const run of runs) {
    const current = epochRunGroups[epochRunGroups.length - 1];
    if (current === undefined || isUserAnchored(run)) {
      epochRunGroups.push([run]);
    } else {
      current.push(run);
    }
  }

  const hasPendingWork = projection.runtimeRequests.some((request) => request.status === "pending");
  const lastEpochIndex = epochRunGroups.length - 1;

  return epochRunGroups.map((epochRuns, epochIndex) => {
    const anchorRun = epochRuns[0];
    const lastRun = epochRuns[epochRuns.length - 1];
    if (anchorRun === undefined || lastRun === undefined) {
      throw new Error("epoch run groups are never empty");
    }
    const userMessages = epochRuns.flatMap((run) => {
      const message = messageById.get(run.userMessageId);
      return message?.createdBy === "user" ? [{ id: message.id, text: message.text }] : [];
    });
    const isEdgeEpoch = epochIndex === 0 || epochIndex === lastEpochIndex;
    const failedRuns = epochRuns.filter(
      (run) => run.status === "failed" || run.status === "interrupted",
    );

    const reasons: string[] = [];
    let priority: "essential" | "high" | "background";
    if (userMessages.length === 0) {
      priority = "background";
      reasons.push("Fully automated epoch with no user ask anchoring it.");
    } else {
      if (epochIndex === 0) reasons.push("First user-anchored epoch in the thread.");
      for (const run of failedRuns) {
        reasons.push(`Run ${run.ordinal} ${run.status}.`);
      }
      if (epochIndex === lastEpochIndex) {
        reasons.push("Latest epoch; reflects the current state of the thread.");
        if (hasPendingWork) reasons.push("Work is still pending on the thread.");
      }
      priority =
        reasons.length > 0 && (isEdgeEpoch || failedRuns.length > 0) ? "essential" : "high";
      if (priority === "high") {
        reasons.push("Routine user follow-up between essential epochs.");
      }
    }

    const runIds = new Set(epochRuns.map((run) => run.id));
    const references = [
      ...projection.subagents
        .filter(
          (subagent) =>
            subagent.childThreadId !== null &&
            subagent.runId !== null &&
            runIds.has(subagent.runId),
        )
        .map((subagent) => ({
          type: "subagent" as const,
          id: subagent.childThreadId as string,
          label: subagent.title ?? subagent.prompt,
          reason: "Delegated to a child thread from a run in this epoch.",
        })),
      ...projection.checkpoints
        .filter((checkpoint) => checkpoint.runId !== null && runIds.has(checkpoint.runId))
        .map((checkpoint) => ({
          type: "checkpoint" as const,
          id: checkpoint.id,
          label: checkpoint.ref as string,
          reason: "Checkpoint captured by a run in this epoch.",
        })),
      ...(epochIndex === lastEpochIndex
        ? (projection.thread.pullRequests ?? []).map((pullRequest) => ({
            type: "pull_request" as const,
            id: pullRequest.url as string,
            label: `${pullRequest.repository}#${pullRequest.number}`,
            reason: "Pull request linked to the thread at handoff.",
          }))
        : []),
    ];

    const assistantReports = isEdgeEpoch
      ? projection.messages
          .filter((message) => message.role === "assistant" && message.runId === anchorRun.id)
          .map((message) => ({ runId: anchorRun.id, text: message.text }))
      : [];

    return {
      id: `epoch-${epochIndex + 1}`,
      fromRunOrdinal: anchorRun.ordinal,
      toRunOrdinal: lastRun.ordinal,
      priority,
      reasons,
      userMessages,
      assistantReports,
      references,
    };
  });
}

export type ThreadHandoverTimeline = ReturnType<typeof buildThreadHandoverTimeline>;
export type ThreadHandoverEpoch = ThreadHandoverTimeline["epochs"][number];

function renderMarkdown(epochs: ReturnType<typeof buildEpochs>) {
  const lines: string[] = ["# Thread Handover Timeline", ""];
  for (const epoch of epochs) {
    const asks =
      epoch.userMessages.map((message) => message.text.replaceAll("\n", " ")).join("; ") ||
      "no user ask";
    lines.push(
      `- ${epoch.id} [${epoch.priority}] runs ${epoch.fromRunOrdinal}-${epoch.toRunOrdinal}: ${asks}`,
    );
  }
  for (const epoch of epochs) {
    if (!(detailPriorities as ReadonlyArray<string>).includes(epoch.priority)) continue;
    lines.push("", `## ${epoch.id} (${epoch.priority})`, "");
    for (const reason of epoch.reasons) lines.push(`- ${reason}`);
    for (const message of epoch.userMessages) {
      lines.push("", message.text);
    }
    for (const report of epoch.assistantReports) {
      lines.push("", `Report from run ${report.runId}:`, "", report.text);
    }
    for (const reference of epoch.references) {
      lines.push(`- ${reference.type}: ${reference.label} (${reference.id}) - ${reference.reason}`);
    }
  }
  return lines.join("\n").concat("\n");
}
