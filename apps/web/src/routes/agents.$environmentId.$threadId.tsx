import { AgentChatRail } from "../components/agents/AgentChatRail";
import { createFileRoute } from "@tanstack/react-router";
import ChatView from "../components/ChatView";
import { resolveThreadRouteRef } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";

export function AgentsThreadView({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const threadRef = resolveThreadRouteRef({ environmentId, threadId });
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const phase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });
  return (
    <div className="agents-thread-view">
      {threadRef && <AgentChatRail current={threadRef} />}
      <div className="agents-chat">
        {threadRef && status !== "deleted" ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            showBackToAgents
            routeKind="server"
            threadSyncPhase={phase}
          />
        ) : (
          <p className="p-6">This thread is no longer available.</p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agents/$environmentId/$threadId")({
  component: () => <AgentsThreadView {...Route.useParams()} />,
});
