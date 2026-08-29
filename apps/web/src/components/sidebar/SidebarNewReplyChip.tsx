import { MessageSquareIcon } from "lucide-react";

import { Badge } from "../ui/badge";

export function SidebarNewReplyChip() {
  return (
    <Badge
      aria-label="New reply"
      className="ml-1.5 gap-1 self-center"
      data-testid="sidebar-new-reply-chip"
      size="sm"
      variant="success"
    >
      <MessageSquareIcon aria-hidden className="size-2.5" />
      New reply
    </Badge>
  );
}
