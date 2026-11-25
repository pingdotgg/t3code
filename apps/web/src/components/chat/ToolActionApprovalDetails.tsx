import {
  TOOL_ACTION_OTHER_REPOSITORY,
  toolActionApprovalRows,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalToolAction } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { ApprovalDetailRows } from "./ApprovalDetailRows";

/** Where a tool asks to act outside the thread, and which tool, under its question. */
export function ToolActionApprovalDetails({
  toolAction,
}: {
  toolAction: ProviderApprovalToolAction;
}) {
  const m = useMessages();
  return (
    <>
      <ApprovalDetailRows detail="tool-action" rows={toolActionApprovalRows(toolAction, m)} />
      {toolAction.otherRepository ? (
        <span className="text-warning wrap-anywhere">{m(TOOL_ACTION_OTHER_REPOSITORY)}</span>
      ) : null}
    </>
  );
}
