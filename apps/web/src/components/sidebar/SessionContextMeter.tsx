import { useState } from "react";
import * as DateTime from "effect/DateTime";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { SESSION_USAGE_WINDOW } from "../../lib/sessionUsage";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../../lib/contextWindow";
import { useQuietThreadProjection } from "../../state/entities";
import { useRetainedValue } from "../Sidebar.logic";
import { newMessageId } from "../../lib/utils";
import { ContextWindowMeter } from "../chat/ContextWindowMeter";
import type { SidebarThreadSummary } from "../../types";

export function SessionContextMeter({
  thread,
  driverKind,
  modelLabel,
}: {
  thread: SidebarThreadSummary;
  driverKind: ProviderDriverKind | null;
  modelLabel: string;
}) {
  const canRead = useEnvironmentScope(thread.environmentId, AuthDiagnosticsReadScope);
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const query = useEnvironmentQuery(
    canRead
      ? serverEnvironment.threadUsageSummary({
          environmentId: thread.environmentId,
          input: SESSION_USAGE_WINDOW,
        })
      : null,
  );
  const context = query.data?.threadContexts?.find((entry) => entry.threadId === thread.id);
  const [pending, setPending] = useState(false);
  const send = useOrchestrationCommand(threadEnvironment.startTurn, "Failed to compact context");
  const busy =
    thread.runtime?.activeRunId != null || thread.hasPendingApprovals || thread.hasPendingUserInput;
  const supported = driverKind === "claudeAgent" || driverKind === "codex";
  const compact = async () => {
    if (!canOperate || busy || pending || !supported) return;
    setPending(true);
    await send({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        message: { messageId: newMessageId(), role: "user", text: "/compact", attachments: [] },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "start",
      },
    }).finally(() => setPending(false));
  };
  const projection = useQuietThreadProjection(
    thread.runtime?.activeRunId != null
      ? { environmentId: thread.environmentId, threadId: thread.id }
      : null,
  )?.projection;
  const providerThread = projection?.providerThreads.find(
    (entry) => entry.id === projection.thread.activeProviderThreadId,
  );
  const live = projection
    ? deriveLatestContextWindowSnapshot(
        projection.visibleTurnItems,
        latestProviderTurnTokenUsage(
          projection.providerTurns.filter((entry) => entry.providerThreadId === providerThread?.id),
          projection,
          providerThread,
        ),
        providerThread,
      )
    : null;
  const retainedLive = useRetainedValue(`${thread.environmentId}:${thread.id}`, live);
  const reported = context
    ? deriveLatestContextWindowSnapshot([], null, {
        contextUsage: context.usage,
        updatedAt: DateTime.makeUnsafe(context.updatedAt),
      })
    : null;
  const usage =
    retainedLive &&
    (!reported || Date.parse(retainedLive.updatedAt) > Date.parse(reported.updatedAt))
      ? retainedLive
      : reported;
  return (
    <ContextWindowMeter
      compact
      usage={usage}
      modelDisplayName={modelLabel}
      onCompact={() => {
        void compact();
      }}
      compactDisabled={!canOperate || busy || pending || !supported}
      compactDisabledReason={
        !canOperate
          ? "This connection cannot change threads."
          : !supported
            ? "Compaction is unavailable for this provider."
            : "Wait for the current turn to finish."
      }
    />
  );
}
