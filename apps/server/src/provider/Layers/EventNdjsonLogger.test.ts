import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

describe("EventNdjsonLogger", () => {
  it("writes effect-style lines to thread-scoped files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");

    try {
      const logger = makeEventNdjsonLogger(basePath);
      expect(logger).toBeDefined();
      if (!logger) {
        return;
      }

      logger.write({
        observedAt: "2026-03-03T12:00:00.000Z",
        stream: "native",
        orchestrationThreadId: "thread-1",
        event: { threadId: "provider-thread-1", id: "evt-1" },
      });
      logger.write({
        observedAt: "2026-03-03T12:00:01.000Z",
        stream: "canonical",
        orchestrationThreadId: "thread-2",
        event: { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
      });
      logger.close();

      const threadOnePath = path.join(tempDir, "thread-1.log");
      const threadTwoPath = path.join(tempDir, "thread-2.log");
      expect(fs.existsSync(threadOnePath)).toBe(true);
      expect(fs.existsSync(threadTwoPath)).toBe(true);

      const first = fs.readFileSync(threadOnePath, "utf8").trim();
      const second = fs.readFileSync(threadTwoPath, "utf8").trim();
      expect(first).toBe(
        '[2026-03-03T12:00:00.000Z] NATIVE: {"threadId":"provider-thread-1","id":"evt-1"}',
      );
      expect(second).toBe(
        '[2026-03-03T12:00:01.000Z] ORCHESTRATION: {"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("drops records without orchestration thread ids", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
    const basePath = path.join(tempDir, "provider-canonical.ndjson");

    try {
      const logger = makeEventNdjsonLogger(basePath);
      expect(logger).toBeDefined();
      if (!logger) {
        return;
      }

      logger.write({ stream: "orchestration", event: { id: "evt-no-thread" } });
      logger.close();

      const logFiles = fs.readdirSync(tempDir).filter((entry) => entry.endsWith(".log"));
      expect(logFiles).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rotates per-thread files when max size is exceeded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");

    try {
      const logger = makeEventNdjsonLogger(basePath, {
        maxBytes: 120,
        maxFiles: 2,
      });
      expect(logger).toBeDefined();
      if (!logger) {
        return;
      }

      for (let index = 0; index < 10; index += 1) {
        logger.write({
          stream: "native",
          orchestrationThreadId: "thread-rotate",
          event: {
            threadId: "provider-thread-rotate",
            id: `evt-${index}`,
            payload: "x".repeat(40),
          },
        });
      }
      logger.close();

      const fileStem = "thread-rotate.log";
      const matchingFiles = fs
        .readdirSync(tempDir)
        .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
        .toSorted();

      expect(matchingFiles.some((entry) => entry === `${fileStem}.1`)).toBe(true);
      expect(matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`)).toBe(
        true,
      );
      expect(matchingFiles.some((entry) => entry === `${fileStem}.3`)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

});
