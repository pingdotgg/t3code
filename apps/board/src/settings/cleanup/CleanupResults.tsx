import type { StorageCleanupReport } from "@t3tools/contracts";

import { formatBytes, reportEntryName } from "../settingsModel";

const OUTCOME = {
  removed: { title: "Removed", tone: "text-emerald-400" },
  kept: { title: "Kept", tone: "text-amber-400" },
  failed: { title: "Failed", tone: "text-red-400" },
} as const;

export function CleanupResults({ report }: { report: StorageCleanupReport }) {
  const { removed, kept, failed } = report.counts;
  return (
    <div aria-label="Latest cleanup results" className="flex flex-col divide-y divide-line">
      <p className="px-3 py-2 text-xs text-muted">
        {removed} removed, {kept} kept{failed > 0 ? `, ${failed} failed` : ""}
      </p>
      {report.entries.length === 0 && (
        <p className="px-3 py-2.5 text-xs text-faint">Nothing needed cleanup.</p>
      )}
      <ul className="divide-y divide-line">
        {report.entries.map((entry) => (
          <li
            key={`${entry.kind}:${entry.path}:${entry.threadId}`}
            className="flex flex-col gap-0.5 px-3 py-2.5"
          >
            <div className="flex items-baseline gap-2">
              <span className={`text-xs font-medium ${OUTCOME[entry.outcome].tone}`}>
                {OUTCOME[entry.outcome].title}
              </span>
              <span className="min-w-0 truncate text-fg">{reportEntryName(entry)}</span>
              {entry.bytes !== null && (
                <span className="ml-auto shrink-0 text-xs text-faint">
                  {formatBytes(entry.bytes)}
                </span>
              )}
            </div>
            <p className="text-xs break-words text-muted">{entry.reason}</p>
            {entry.path !== null && (
              <p className="font-mono text-xs break-all text-faint">{entry.path}</p>
            )}
            {entry.threadTitle !== null && (
              <p className="text-xs text-faint">Thread: {entry.threadTitle}</p>
            )}
          </li>
        ))}
      </ul>
      {report.omittedCount > 0 && (
        <p className="px-3 py-2 text-xs text-faint">{report.omittedCount} more results.</p>
      )}
    </div>
  );
}
