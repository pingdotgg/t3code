import type { BotWorkerRequest } from "@t3tools/client-runtime/state/thread-requests";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { OtherThreadApproval } from "../chat/ChildThreadApprovals";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

function WorkerApproval({ request }: { request: BotWorkerRequest }) {
  const gt = useGT();
  const [collapsed, setCollapsed] = useState(false);
  const { approval } = request;
  return (
    <Collapsible open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={collapsed ? gt("Show the approval") : gt("Hide the approval")}
        className="px-4 py-1.5"
      >
        <ComposerBanner.Content>
          <span className="max-w-1/3 min-w-0 truncate font-medium text-foreground">
            {request.title}
          </span>
          <ComposerBanner.Separator />
          <span className="min-w-0 shrink-0 truncate text-muted-foreground">
            <T>Needs approval</T>
          </span>
          {collapsed ? (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {approval.detail || approval.requestKind}
              </span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="gap-0">
          <ComposerBanner.ToggleIcon expanded={!collapsed} />
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="ps-6 pe-4 pt-0.5 pb-2 sm:ps-5.5">
          <OtherThreadApproval thread={request.thread} approval={approval} />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function WorkerRequestCard({ request }: { request: BotWorkerRequest }) {
  const gt = useGT();
  return (
    <ComposerBanner.Root
      detached
      variant="info"
      role="region"
      aria-label={gt("Request from {title}", { title: request.title })}
    >
      <WorkerApproval request={request} />
    </ComposerBanner.Root>
  );
}

/** The approvals the Bot's workers wait on, answered on each worker's own request. */
export function BotWorkerRequests({ requests }: { requests: ReadonlyArray<BotWorkerRequest> }) {
  if (requests.length === 0) return null;
  return (
    <div className="chat-content-lane flex flex-col gap-2 pb-2">
      {requests.map((request) => (
        <WorkerRequestCard
          key={JSON.stringify([
            request.thread.environmentId,
            request.thread.threadId,
            request.approval.requestId,
          ])}
          request={request}
        />
      ))}
    </div>
  );
}
