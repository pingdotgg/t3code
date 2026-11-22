import { providerLimitedUntilMs, type ServerProvider } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatUpcomingTimestamp } from "../../timestampFormat";
import { m, type MessageResolver } from "../../i18n/messages";

export function limitedUntilLabel(
  provider: Pick<ServerProvider, "limitedUntil">,
  nowMs: number,
  timestampFormat: TimestampFormat,
  resolve: MessageResolver = m,
): string | null {
  if (provider.limitedUntil === undefined || providerLimitedUntilMs(provider, nowMs) === null) {
    return null;
  }
  return resolve(
    msg("Limited until {time}", {
      time: formatUpcomingTimestamp(provider.limitedUntil, timestampFormat, nowMs),
    }),
  );
}
