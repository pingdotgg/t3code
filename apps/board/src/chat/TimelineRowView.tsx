import { AssistantRow } from "./AssistantRow";
import type { TimelineRow } from "./timeline";
import { UserRow } from "./UserRow";
import { WorkRow } from "./WorkRow";

export function TimelineRowView({ row, brief }: { row: TimelineRow; brief: boolean }) {
  switch (row.kind) {
    case "user":
      return <UserRow text={row.text} brief={brief} />;
    case "assistant":
      return <AssistantRow text={row.text} streaming={row.streaming} />;
    case "work":
      return <WorkRow steps={row.steps} />;
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
