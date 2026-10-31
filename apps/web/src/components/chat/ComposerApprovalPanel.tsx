import { ChevronDownIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import type { PendingApproval } from "../../session-logic";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerRequestCard } from "./ComposerRequestCard";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

export function ComposerApprovalPanel({
  approval,
  count,
  disabled,
  isResponding,
  onRespond,
}: {
  approval: PendingApproval;
  count: number;
  disabled: boolean;
  isResponding: boolean;
  onRespond: (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const title =
    approval.requestKind === "command"
      ? "Command approval"
      : approval.requestKind === "file-change"
        ? "File change approval"
        : "Permission approval";
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      render={<ComposerRequestCard.Root data-chat-composer-request-card="approval" />}
    >
      <ComposerRequestCard.Header
        render={<CollapsibleTrigger render={<button type="button" />} />}
        icon={<ShieldIcon />}
        title={title}
        sub={expanded ? null : approval.detail}
        trailing={
          <>
            {count > 1 ? <ComposerRequestCard.Counter index={1} total={count} /> : null}
            <ChevronDownIcon className="size-3" />
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="Cancel approval"
              disabled={disabled || isResponding}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (disabled || isResponding) return;
                void onRespond(approval.requestId, "cancel");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (disabled || isResponding) return;
                  void onRespond(approval.requestId, "cancel");
                }
              }}
            />
          </>
        }
      />
      <CollapsiblePanel>
        <ComposerRequestCard.Well>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap p-2 font-mono text-meta text-foreground wrap-anywhere">
            {approval.detail}
          </pre>
          {approval.files?.map((file) => (
            <div key={file.path} className="flex min-w-0 items-center gap-2 px-2 pb-1 text-meta">
              <span className="truncate">{file.path}</span>
              <span className="text-success-foreground">
                {file.additions !== undefined ? `+${file.additions}` : null}
              </span>
              <span className="text-error-foreground">
                {file.deletions !== undefined ? `−${file.deletions}` : null}
              </span>
            </div>
          ))}
        </ComposerRequestCard.Well>
        {approval.reason ? (
          <ComposerRequestCard.Body>{approval.reason}</ComposerRequestCard.Body>
        ) : null}
        <ComposerRequestCard.Footer>
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            disabled={disabled}
            isResponding={isResponding}
            canRespond={approval.responseCapability === "live"}
            options={approval.options}
            alwaysAllow={alwaysAllow}
            onAlwaysAllowChange={setAlwaysAllow}
            onRespondToApproval={onRespond}
          />
        </ComposerRequestCard.Footer>
      </CollapsiblePanel>
    </Collapsible>
  );
}
