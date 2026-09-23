import { createDebugLogger } from "../../lib/debugLog";

const logger = createDebugLogger("cloud", {
  enabledInDev: true,
  legacyGlobalFlag: "__T3_CLOUD_DEBUG__",
});

export function isCloudDebugEnabled(): boolean {
  return logger.isEnabled();
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  logger.log(event, data);
}
