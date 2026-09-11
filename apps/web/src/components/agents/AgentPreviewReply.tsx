import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadDetail, useThreadStatus } from "../../state/entities";
import { resolveThreadSyncPhase } from "../../threadSync";
import ChatView from "../ChatView";

export function AgentPreviewReply({
  thread,
  onSent,
}: {
  thread: EnvironmentThreadShell;
  onSent: () => void;
}) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const detail = useThreadDetail(ref);
  const status = useThreadStatus(ref);
  return (
    <ChatView
      composerOnly
      environmentId={thread.environmentId}
      threadId={thread.id}
      routeKind="server"
      threadSyncPhase={resolveThreadSyncPhase({
        detailExists: detail !== null,
        shellExists: true,
        status,
      })}
      onTurnStarted={onSent}
    />
  );
}
