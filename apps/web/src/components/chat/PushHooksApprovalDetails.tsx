import { pushHooksApprovalRows } from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalPushHooks } from "@t3tools/contracts";
import { useMessages } from "gt-react";

/** The branch and hooks a push hooks approval names, under its question. */
export function PushHooksApprovalDetails({ pushHooks }: { pushHooks: ProviderApprovalPushHooks }) {
  const m = useMessages();
  return (
    <dl
      className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta text-muted-foreground"
      data-approval-detail="push-hooks"
    >
      {pushHooksApprovalRows(pushHooks, m).map((row, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows never reorder and two hooks may read alike
        <div key={index} className="contents">
          <dt className="text-foreground/80">{row.label}</dt>
          <dd className="min-w-0 select-text wrap-anywhere">
            {row.name ? <span className="me-2 text-foreground">{row.name}</span> : null}
            <code className="font-mono text-foreground">{row.code}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}
