import type { TerminalSummary } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export interface ThreadTerminalGroups {
  readonly running: ReadonlyArray<TerminalSummary>;
  readonly settled: ReadonlyArray<TerminalSummary>;
  readonly failedCount: number;
}

export function terminalFailed(summary: TerminalSummary): boolean {
  return summary.status === "error" || (summary.exitCode !== null && summary.exitCode !== 0);
}

/** An idle shell the user owns is just a prompt; only work worth watching makes a group. */
export function groupThreadTerminals(
  summaries: ReadonlyArray<TerminalSummary>,
): ThreadTerminalGroups {
  const running: TerminalSummary[] = [];
  const settled: TerminalSummary[] = [];
  for (const summary of summaries) {
    if (summary.status === "exited" || summary.status === "error") settled.push(summary);
    else if (summary.controller === "agent" || summary.hasRunningSubprocess) running.push(summary);
  }
  return { running, settled, failedCount: settled.filter(terminalFailed).length };
}

export function terminalGroupLabel(
  group: "running" | "settled",
  count: number,
  resolve: MessageResolver = m,
): string {
  return group === "running"
    ? resolve(
        msg("{count, plural, one {{count} running terminal} other {{count} running terminals}}", {
          count,
        }),
      )
    : resolve(
        msg("{count, plural, one {{count} settled terminal} other {{count} settled terminals}}", {
          count,
        }),
      );
}

export function terminalStatusLabel(
  summary: TerminalSummary,
  resolve: MessageResolver = m,
): string {
  if (summary.status === "error") return resolve(msg("Error", { $context: "terminal status" }));
  if (summary.status === "exited") {
    return summary.exitCode === null || summary.exitCode === 0
      ? resolve(msg("Exited", { $context: "terminal status" }))
      : resolve(
          msg("Exit {code}", { code: summary.exitCode, $context: "terminal status, exit code" }),
        );
  }
  return summary.hasRunningSubprocess
    ? resolve(msg("Running", { $context: "terminal status" }))
    : resolve(msg("Idle", { $context: "terminal status" }));
}
