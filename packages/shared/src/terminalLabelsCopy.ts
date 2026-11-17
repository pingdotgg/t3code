import type { TerminalSummary } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { terminalNumber } from "./terminalLabels.ts";

/** @public */
export function getTerminalLabel(terminalId: string, resolve: MFunctionType = mFallback): string {
  const numericSuffix = terminalNumber(terminalId);
  return numericSuffix ? resolve(msg("Terminal {number}", { number: numericSuffix })) : terminalId;
}

/** @public */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label"> | null | undefined,
  resolve: MFunctionType = mFallback,
): string {
  const trimmed = summary?.label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : getTerminalLabel(terminalId, resolve);
}
