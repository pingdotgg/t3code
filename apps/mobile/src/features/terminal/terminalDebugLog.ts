import { createDebugLogger } from "../../lib/debugLog";

const logger = createDebugLogger("terminal", {
  enabledInDev: true,
  legacyGlobalFlag: "__T3_TERMINAL_DEBUG__",
});

export function terminalDebugLog(message: string, data?: Record<string, unknown>): void {
  logger.log(message, data);
}
