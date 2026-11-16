import { ClipboardCheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

/** The run's verdicts and evidence. Shows an empty state until the evidence bundle (#23) exists. */
export function ThreadDetailsTestRun() {
  return (
    <ThreadDetailsSection headingId="thread-details-test-run-heading" title="Test run">
      <div className="flex flex-col">
        <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
          <ClipboardCheckIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="truncate text-muted-foreground">No verdicts yet</span>
        </div>
      </div>
    </ThreadDetailsSection>
  );
}
