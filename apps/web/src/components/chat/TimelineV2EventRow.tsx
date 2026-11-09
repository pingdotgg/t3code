import { type TimelineRow, TimelineRowCtx } from "./timelineRowContext";
import { WorkLogBlock } from "./WorkLog";
import { memo, use } from "react";
import { V2LifecycleRow } from "./V2LifecycleRow";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";

export function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type === "subagent" && (row.subagents?.length ?? 1) > 1) {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  if (item.type === "secret_request") {
    return (
      <SecretRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  if (item.type === "link_request") {
    return (
      <LinkRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  return (
    <V2LifecycleRow
      environmentId={ctx.activeThreadEnvironmentId}
      item={item}
      resourceSummary={row.resourceSummary}
      runs={ctx.runs}
      onOpenThread={ctx.onOpenThread}
    />
  );
}

/** Subagents started together: one quiet row each, in the order they were started. */
export const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      {(row.subagents ?? [row.projectedItem]).map(({ item }) =>
        item.type === "subagent" ? (
          <V2LifecycleRow
            environmentId={ctx.activeThreadEnvironmentId}
            key={item.id}
            item={item}
            runs={ctx.runs}
            onOpenThread={ctx.onOpenThread}
          />
        ) : null,
      )}
    </WorkLogBlock>
  );
});
