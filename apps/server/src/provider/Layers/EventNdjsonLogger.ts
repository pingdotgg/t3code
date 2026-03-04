/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import { RotatingFileSink } from "@t3tools/shared/logging";
import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { createLogger } from "../../logger.ts";

const logger = createLogger("provider-observability");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (record: unknown) => void;
  close: () => void;
}

export interface EventNdjsonLoggerOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

function stringifyRecord(record: unknown): string | undefined {
  try {
    return JSON.stringify(record);
  } catch (error) {
    logger.warn("failed to serialize provider event log record", { error });
    return undefined;
  }
}

function normalizeThreadSegment(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  return toSafeThreadAttachmentSegment(raw);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveThreadSegment(record: unknown): string | null {
  const root = asObject(record);
  return normalizeThreadSegment(root?.orchestrationThreadId);
}

function resolveThreadFilePath(baseFilePath: string, threadSegment: string): string {
  const dir = path.dirname(baseFilePath);
  return path.join(dir, `${threadSegment}.log`);
}

function resolveObservedAt(raw: unknown): string {
  if (typeof raw !== "string") {
    return new Date().toISOString();
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return new Date().toISOString();
  }
  return trimmed;
}

function resolveStreamLabel(raw: unknown): string {
  if (typeof raw !== "string") {
    return "ORCHESTRATION";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "native") {
    return "NATIVE";
  }
  if (normalized === "canonical" || normalized === "orchestration") {
    return "ORCHESTRATION";
  }
  if (normalized.length === 0) {
    return "ORCHESTRATION";
  }
  return normalized.toUpperCase();
}

function toLogLine(record: unknown): string | undefined {
  const root = asObject(record);
  const payload = root && "event" in root ? root.event : record;
  const serializedPayload = stringifyRecord(payload);
  if (!serializedPayload) {
    return undefined;
  }
  const observedAt = resolveObservedAt(root?.observedAt);
  const streamLabel = resolveStreamLabel(root?.stream);
  return `[${observedAt}] ${streamLabel}: ${serializedPayload}\n`;
}

export function makeEventNdjsonLogger(
  filePath: string,
  options?: EventNdjsonLoggerOptions,
): EventNdjsonLogger | undefined {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (error) {
    logger.warn("failed to create provider event log directory", { filePath, error });
    return undefined;
  }

  try {
    let broken = false;
    const sinks = new Map<string, RotatingFileSink>();
    const failedSegments = new Set<string>();

    const resolveSink = (threadSegment: string): RotatingFileSink | undefined => {
      if (failedSegments.has(threadSegment)) {
        return undefined;
      }
      const existingSink = sinks.get(threadSegment);
      if (existingSink) {
        return existingSink;
      }

      const threadFilePath = resolveThreadFilePath(filePath, threadSegment);
      try {
        const sink = new RotatingFileSink({
          filePath: threadFilePath,
          maxBytes,
          maxFiles,
          throwOnError: true,
        });
        sinks.set(threadSegment, sink);
        return sink;
      } catch (error) {
        failedSegments.add(threadSegment);
        logger.warn("failed to initialize provider thread log file", {
          filePath: threadFilePath,
          threadSegment,
          error,
        });
        return undefined;
      }
    };

    return {
      filePath,
      write(record: unknown) {
        if (broken) {
          return;
        }
        const threadSegment = resolveThreadSegment(record);
        if (!threadSegment) {
          return;
        }
        const line = toLogLine(record);
        if (!line) {
          return;
        }
        const sink = resolveSink(threadSegment);
        if (!sink) {
          return;
        }
        try {
          sink.write(line);
        } catch (error) {
          broken = true;
          logger.warn("provider event log write failed", { filePath, threadSegment, error });
        }
      },
      close() {
        sinks.clear();
      },
    };
  } catch (error) {
    logger.warn("failed to create provider event log file", { filePath, error });
    return undefined;
  }
}
