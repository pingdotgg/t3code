/**
 * Provider event NDJSON logger helper.
 *
 * Best-effort writer for observability logs. Failures are downgraded to warnings
 * so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../../logger.ts";

const logger = createLogger("provider-observability");

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (record: unknown) => void;
  close: () => void;
}

function stringifyRecord(record: unknown): string | undefined {
  try {
    return JSON.stringify(record);
  } catch (error) {
    logger.warn("failed to serialize provider event log record", { error });
    return undefined;
  }
}

export function makeEventNdjsonLogger(filePath: string): EventNdjsonLogger | undefined {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, "", { encoding: "utf8", flag: "a" });
  } catch (error) {
    logger.warn("failed to create provider event log directory", { filePath, error });
    return undefined;
  }

  try {
    let broken = false;

    return {
      filePath,
      write(record: unknown) {
        if (broken) {
          return;
        }
        const serialized = stringifyRecord(record);
        if (!serialized) {
          return;
        }
        try {
          fs.appendFileSync(filePath, `${serialized}\n`, { encoding: "utf8", flag: "a" });
        } catch (error) {
          broken = true;
          logger.warn("provider event log write failed", { filePath, error });
        }
      },
      close() {
        // no-op for sync append logger
      },
    };
  } catch (error) {
    logger.warn("failed to create provider event log file", { filePath, error });
    return undefined;
  }
}
