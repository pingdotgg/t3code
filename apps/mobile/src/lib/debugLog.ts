export interface DebugLogger {
  readonly isEnabled: () => boolean;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

export interface DebugLoggerOptions {
  readonly enabledInDev?: boolean;
  readonly legacyGlobalFlag?: string;
}

function globalValue(name: string): unknown {
  return typeof globalThis === "undefined"
    ? undefined
    : (globalThis as Record<string, unknown>)[name];
}

export function createDebugLogger(
  namespace: string,
  options: DebugLoggerOptions = {},
): DebugLogger {
  const isEnabled = () => {
    if (options.enabledInDev === true && typeof __DEV__ !== "undefined" && __DEV__) {
      return true;
    }
    if (options.legacyGlobalFlag !== undefined && globalValue(options.legacyGlobalFlag) === true) {
      return true;
    }
    const filter = globalValue("__T3_DEBUG__");
    return filter === true || (Array.isArray(filter) && filter.includes(namespace));
  };
  const log = (event: string, data?: Record<string, unknown>) => {
    if (!isEnabled()) {
      return;
    }
    if (data === undefined) {
      console.log(`[t3-${namespace}] ${event}`);
    } else {
      console.log(`[t3-${namespace}] ${event}`, data);
    }
  };
  return { isEnabled, log };
}
