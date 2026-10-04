import {
  formatClaudeContextHeadline,
  type ClaudeContextReport,
} from "@t3tools/shared/claudeContextReport";
import { ChartPieIcon } from "lucide-react";

import { ClaudeContextCard } from "./ClaudeContextCard";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function claudeContextBannerItem(
  id: string,
  report: ClaudeContextReport,
  onDismiss: () => void,
): ComposerBannerStackItem {
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <ChartPieIcon />,
    title: "Context window",
    description: `${report.model ?? "Claude"} · ${formatClaudeContextHeadline(report)}`,
    dismissLabel: "Dismiss context window",
    onDismiss,
    children: (
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="pt-1 pb-1.5 pe-2">
          <ClaudeContextCard report={report} />
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
    ),
  };
}
