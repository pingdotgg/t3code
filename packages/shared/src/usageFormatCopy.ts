import type { UsageSource } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  formatRelativeHourShort as formatRelativeHourShortWith,
  usageSourceMessages as usageSourceMessagesWith,
} from "./usageFormat.ts";
import type { UsageContractMismatch } from "./usageMerge.ts";

/** @public */
export function usageSourceMessages(
  sources: readonly UsageSource[],
  resolve: MFunctionType = mFallback,
): readonly string[] {
  return usageSourceMessagesWith(sources, (count) =>
    resolve(
      msg(
        "{count, plural, one {{count} malformed or inconsistent usage record was skipped; usage may be incomplete.} other {{count} malformed or inconsistent usage records were skipped; usage may be incomplete.}}",
        { count },
      ),
    ),
  );
}

/** @public */
export function formatUsageContractMismatch(
  environmentLabel: string,
  mismatch: Pick<UsageContractMismatch, "direction">,
  resolve: MFunctionType = mFallback,
): string {
  return mismatch.direction === "serverBehind"
    ? resolve(
        msg("{environment} runs an older server version and is excluded from totals.", {
          environment: environmentLabel,
        }),
      )
    : resolve(
        msg(
          "This client is older than the server on {environment}; its usage is excluded from totals.",
          { environment: environmentLabel },
        ),
      );
}

/** @public */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
  hour12 = true,
  resolve: MFunctionType = mFallback,
  locale?: string,
): string {
  return formatRelativeHourShortWith(
    hourStart,
    relativeTo,
    timeZone,
    hour12,
    (hour, daysAgo) =>
      daysAgo === 0
        ? resolve(msg("{hour} today", { hour }))
        : resolve(msg("{hour} yesterday", { hour })),
    locale,
  );
}
