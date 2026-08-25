import { priorityColorVar, priorityIsUrgent } from "../../brand/statusColors";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * A report's priority. P0 and P1 carry their color into the chip so they are
 * findable down a long list; P2 and below keep the plain outline, so a queue
 * of them does not read as a row of alarms.
 */
export function PriorityChip({
  priority,
  className,
}: {
  readonly priority: string;
  readonly className?: string;
}) {
  const color = priorityColorVar(priority);
  const urgent = priorityIsUrgent(priority);

  return (
    <Badge
      size="sm"
      variant="outline"
      className={cn("rounded-full px-1.5 font-medium", className)}
      style={{
        color,
        ...(urgent
          ? {
              backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
              borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
            }
          : null),
      }}
    >
      {priority}
    </Badge>
  );
}
