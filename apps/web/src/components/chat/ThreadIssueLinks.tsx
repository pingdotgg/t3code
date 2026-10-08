import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";
import { useThreadShell } from "~/state/entities";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";

export function ThreadIssueLinks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const issues = thread?.issues ?? [];
  if (!thread || issues.length === 0) return null;

  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label="Linked issues"
      onClick={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
    >
      <CircleDotIcon aria-hidden className="size-3.5" />
      {issues.length}
    </Button>
  );
}
