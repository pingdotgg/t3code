import { SquareKanbanIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { useBoardCards } from "./useBoardCards";

/** The sidebar footer's board icon, with how many threads are waiting on you. */
export function ThreadBoardFooterIcon() {
  const needsYou = useBoardCards().filter((card) => card.lane === "needs").length;
  return (
    <span className="relative inline-flex">
      <SquareKanbanIcon />
      {needsYou === 0 ? null : (
        <Badge size="sm" variant="warning" className="absolute -top-1.5 -right-2" aria-hidden>
          {needsYou}
        </Badge>
      )}
    </span>
  );
}
