import { priorityColorVar } from "../../brand/statusColors";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * A report's priority. The label carries the urgency color; the chip itself
 * stays unfilled so a list of them does not read as a row of alarms.
 */
export function PriorityChip({
  priority,
  className,
}: {
  readonly priority: string;
  readonly className?: string;
}) {
  return (
    <Badge
      size="sm"
      variant="outline"
      className={cn("rounded-full px-1.5 font-medium", className)}
      style={{ color: priorityColorVar(priority) }}
    >
      {priority}
    </Badge>
  );
}
