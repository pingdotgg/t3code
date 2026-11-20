import type { EnvironmentId } from "@t3tools/contracts";

import { AssistantRow } from "./AssistantRow";
import type { TimelineRow } from "./timeline";
import { UserRow } from "./UserRow";
import { WorkRow } from "./WorkRow";

export function TimelineRowView({
  row,
  brief,
  environmentId,
}: {
  row: TimelineRow;
  brief: boolean;
  environmentId: EnvironmentId;
}) {
  switch (row.kind) {
    case "user":
      return <UserRow text={row.text} brief={brief} at={row.at} />;
    case "assistant":
      return (
        <AssistantRow
          text={row.text}
          streaming={row.streaming}
          at={row.at}
          turnStartedAt={row.turnStartedAt}
        />
      );
    case "work":
      return <WorkRow steps={row.steps} environmentId={environmentId} />;
    case "notice":
      return (
        <p
          role={row.error ? "alert" : "status"}
          className={row.error ? "text-red-400" : "text-faint"}
        >
          {row.text}
        </p>
      );
  }
}
