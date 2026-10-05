/* oxlint-disable react/no-array-index-key */
import {
  contextSegmentColor,
  contextUsedCategories,
  formatContextHeadline,
  formatContextPercent,
  formatContextTokens,
  type ContextReport,
  type ContextSection,
} from "@t3tools/shared/contextReport";
import { ChartPieIcon, ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";

function SectionRow({ section }: { section: ContextSection }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-icon-muted transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-start text-foreground">{section.title}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {section.totalTokens !== null ? `${formatContextTokens(section.totalTokens)} · ` : ""}
          {section.rows.length}
        </span>
      </button>
      {open ? (
        <table className="ms-5 mb-1 w-[calc(100%-1.25rem)] text-xs">
          <thead className="text-secondary-label">
            <tr>
              {section.columns.map((column, columnIndex) => (
                <th key={columnIndex} className="px-1 py-0.5 text-start font-medium last:text-end">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            {section.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="px-1 py-0.5 tabular-nums [overflow-wrap:anywhere] last:text-end"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export const ContextReportCard = memo(function ContextReportCard({
  report,
}: {
  report: ContextReport;
}) {
  const used = contextUsedCategories(report);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(100, report.usedPercent))}
        aria-label="Context window usage"
      >
        {used.length > 0 ? (
          used.map((category, index) => (
            <span
              key={category.name}
              className="h-full"
              style={{
                width: `${Math.min(100, category.percent)}%`,
                backgroundColor: contextSegmentColor(index, used.length),
              }}
            />
          ))
        ) : (
          <span
            className="h-full bg-muted-foreground/72"
            style={{ width: `${Math.min(100, report.usedPercent)}%` }}
          />
        )}
      </div>
      {report.overLimit ? (
        <div className="text-xs text-destructive-foreground">Over limit: {report.overLimit}</div>
      ) : null}
      {report.categories.length > 0 ? (
        <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
          {report.categories.map((category) => {
            const usedIndex = used.indexOf(category);
            return (
              <li key={category.name} className="contents">
                <span
                  aria-hidden="true"
                  className={cn("size-2 rounded-full", usedIndex === -1 && "bg-muted")}
                  style={
                    usedIndex === -1
                      ? undefined
                      : { backgroundColor: contextSegmentColor(usedIndex, used.length) }
                  }
                />
                <span className="truncate text-foreground">{category.name}</span>
                <span className="text-muted-foreground tabular-nums">{category.tokens}</span>
                <span className="min-w-10 text-end text-secondary-label tabular-nums">
                  {formatContextPercent(category.percent)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {report.sections.length > 0 ? (
        <div className="-mx-1 border-t border-border/60 pt-1">
          {report.sections.map((section) => (
            <SectionRow key={section.title} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

export function ContextReportDisclosure({
  report,
  expanded,
  onToggle,
}: {
  report: ContextReport;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-h-6 cursor-pointer select-none items-center gap-1.5 rounded-md px-0.5 text-start text-sm leading-relaxed transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <ChartPieIcon aria-hidden className="block size-4 shrink-0 stroke-2 opacity-70" />
        </span>
        <span className="min-w-0 flex-1 truncate text-secondary-label">
          Context window · {report.model ? `${report.model} · ` : ""}
          {formatContextHeadline(report)}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      {expanded ? (
        <div className="ms-7 px-0.5 py-1 select-text">
          <ContextReportCard report={report} />
        </div>
      ) : null}
    </div>
  );
}
