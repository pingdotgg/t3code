import { pushHooksApprovalRows } from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalPushHooks } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { ApprovalDetailRows } from "./ApprovalDetailRows";

/** The branch and hooks a push hooks approval names, under its question. */
export function PushHooksApprovalDetails({ pushHooks }: { pushHooks: ProviderApprovalPushHooks }) {
  const m = useMessages();
  return <ApprovalDetailRows detail="push-hooks" rows={pushHooksApprovalRows(pushHooks, m)} />;
}
