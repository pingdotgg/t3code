import { threadAutoSettlePolicy } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  DEFAULT_THREAD_AUTO_SETTLE_MODE,
} from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

export function resolveMobileThreadAutoSettlePolicy(preferences: Preferences) {
  return threadAutoSettlePolicy({
    mode: preferences.threadAutoSettleMode ?? DEFAULT_THREAD_AUTO_SETTLE_MODE,
    afterDays: DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  });
}
