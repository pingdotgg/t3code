import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

describe("EventNdjsonLogger", () => {
  it("writes NDJSON records to disk", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-"));
    const filePath = path.join(tempDir, "provider-native.ndjson");

    try {
      const logger = makeEventNdjsonLogger(filePath);
      expect(logger).toBeDefined();
      if (!logger) {
        return;
      }

      logger.write({ type: "native", payload: { id: "evt-1" } });
      logger.write({ type: "canonical", payload: { id: "evt-2" } });
      logger.close();

      const raw = fs.readFileSync(filePath, "utf8").trim();
      const lines = raw.split("\n");
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0] ?? "{}");
      const second = JSON.parse(lines[1] ?? "{}");
      expect(first).toEqual({ type: "native", payload: { id: "evt-1" } });
      expect(second).toEqual({ type: "canonical", payload: { id: "evt-2" } });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
