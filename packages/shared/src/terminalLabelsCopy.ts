import type { TerminalSummary } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { getTerminalLabel as getServerTerminalLabel, terminalNumber } from "./terminalLabels.ts";

/** @public */
export function getTerminalLabel(terminalId: string, resolve: MFunctionType = mFallback): string {
  const numericSuffix = terminalNumber(terminalId);
  return numericSuffix ? resolve(msg("Terminal {number}", { number: numericSuffix })) : terminalId;
}

/**
 * Server labels name the running process; its English idle default is shown in the app's language.
 * @public
 */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary:
    | (Pick<TerminalSummary, "label"> & Partial<Pick<TerminalSummary, "hasRunningSubprocess">>)
    | null
    | undefined,
  resolve: MFunctionType = mFallback,
): string {
  const trimmed = summary?.label?.trim();
  return trimmed &&
    (summary?.hasRunningSubprocess || trimmed !== getServerTerminalLabel(terminalId))
    ? trimmed
    : getTerminalLabel(terminalId, resolve);
}
