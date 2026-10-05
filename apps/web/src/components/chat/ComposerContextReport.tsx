import { formatContextHeadline, type ContextReport } from "@t3tools/shared/contextReport";
import { ChartPieIcon } from "lucide-react";

import { ContextReportCard } from "./ContextReportCard";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function contextReportBannerItem(
  id: string,
  report: ContextReport,
  onDismiss: () => void,
): ComposerBannerStackItem {
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <ChartPieIcon />,
    title: "Context window",
    description: `${report.model ? `${report.model} · ` : ""}${formatContextHeadline(report)}`,
    dismissLabel: "Dismiss context window",
    onDismiss,
    children: (
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="pt-1 pb-1.5 pe-2">
          <ContextReportCard report={report} />
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
    ),
  };
}
