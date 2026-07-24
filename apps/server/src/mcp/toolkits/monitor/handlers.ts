import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MonitorRegistry from "../../../monitor/MonitorRegistry.ts";
import { cursorFromSnapshot } from "../../../monitor/monitorDiff.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { getPullRequestMonitorSnapshot } from "../../../sourceControl/gitHubPullRequestMonitor.ts";
import { MonitorStartError, MonitorToolkit } from "./tools.ts";

const monitorStart = Effect.fn("MonitorToolkit.monitorStart")(function* ({
  prNumber,
}: {
  readonly prNumber: number;
}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("monitor")) {
    return yield* new MonitorStartError({ message: "PR monitoring is not available." });
  }
  const registry = yield* MonitorRegistry.MonitorRegistry;
  const existing = yield* registry.get(invocation.threadId);
  if (Option.isSome(existing)) {
    if (existing.value.prNumber !== prNumber) {
      return yield* new MonitorStartError({
        message: `This thread is already monitoring PR #${existing.value.prNumber}. Ask the user before switching to a different pull request.`,
      });
    }
    return {
      prNumber,
      status: "monitoring" as const,
      warning: null,
      message: `PR #${prNumber} is already being monitored.`,
    };
  }

  const snapshots = yield* ProjectionSnapshotQuery;
  const readModel = yield* snapshots.getCommandReadModel();
  const thread = readModel.threads.find((candidate) => candidate.id === invocation.threadId);
  const project = thread
    ? readModel.projects.find((candidate) => candidate.id === thread.projectId)
    : undefined;
  if (!thread || !project) {
    return yield* new MonitorStartError({ message: "The invoking thread no longer exists." });
  }
  const repoCwd = thread.worktreePath ?? project.workspaceRoot;
  const snapshot = yield* getPullRequestMonitorSnapshot({
    cwd: repoCwd,
    pullRequestNumber: prNumber,
  }).pipe(Effect.mapError((error) => new MonitorStartError({ message: error.message })));
  if (snapshot.state !== "open") {
    return yield* new MonitorStartError({
      message: `PR #${prNumber} is ${snapshot.state}; only open pull requests can be monitored.`,
    });
  }

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const crypto = yield* Crypto.Crypto;
  const commandId = CommandId.make(yield* crypto.randomUUIDv4);
  const warning = snapshot.draft
    ? `PR #${prNumber} is a draft. Monitoring started, but review bots may not run until it is marked ready for review.`
    : null;
  const generation = yield* registry.nextGeneration;
  const won = yield* registry.registerIfAbsent({
    threadId: invocation.threadId,
    prNumber,
    generation,
    startedAt: createdAt,
    cursor: cursorFromSnapshot(snapshot),
    wakeCount: 0,
    repoCwd,
  });
  if (!won) {
    // A concurrent monitor_start beat us between the existence check and the
    // registration write. Surface it rather than clobbering the winner.
    return yield* new MonitorStartError({
      message: "A monitor was just started for this thread; check its status before retrying.",
    });
  }
  yield* OrchestrationEngineService.pipe(
    Effect.flatMap((engine) =>
      engine.dispatch({
        type: "thread.monitor.start",
        commandId,
        threadId: invocation.threadId,
        prNumber,
        blockersSummary: warning ?? "",
        headSha: snapshot.headSha,
        createdAt,
      }),
    ),
    Effect.mapError((error) => new MonitorStartError({ message: String(error) })),
    // Roll back only the registration this call installed — a raced winner's
    // registration must survive our failure.
    Effect.onError(() => registry.removeGeneration(invocation.threadId, generation)),
  );
  return {
    prNumber,
    status: "monitoring" as const,
    warning,
    message: warning ?? `Started monitoring PR #${prNumber}.`,
  };
});

export const MonitorToolkitHandlersLive = MonitorToolkit.toLayer({
  monitor_start: (input) =>
    monitorStart(input).pipe(
      Effect.catch((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "MonitorStartError"
          ? error
          : new MonitorStartError({ message: String(error) }),
      ),
    ),
});
