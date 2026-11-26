import type { ApprovalDetailRow } from "@t3tools/client-runtime/state/thread-requests";

/** What one of T3 Code's own approvals names, under its question. */
export function ApprovalDetailRows({
  rows,
  detail,
}: {
  rows: ReadonlyArray<ApprovalDetailRow>;
  detail: "push-hooks" | "tool-action";
}) {
  return (
    <dl
      className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
      data-approval-detail={detail}
    >
      {rows.map((row, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows never reorder and two may read alike
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
