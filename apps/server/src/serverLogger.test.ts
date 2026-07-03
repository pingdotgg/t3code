import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Logger } from "effect";

import { makeServerLogFileLogger } from "./serverLogger.ts";

describe("makeServerLogFileLogger", () => {
  it.effect("writes structured JSON lines including log annotations", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-server-log-"));
      const filePath = path.join(tempDir, "server.log");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const logger = yield* makeServerLogFileLogger({
              filePath,
              maxBytes: 10 * 1024 * 1024,
              maxFiles: 10,
              batchWindowMs: 60_000,
            });
            assert.isDefined(logger);
            if (!logger) return;

            yield* Effect.logInfo("hello from server logger test", {
              threadId: "thread-1",
            }).pipe(Effect.provide(Logger.layer([logger])));
          }),
        );

        const content = fs.readFileSync(filePath, "utf8").trim();
        assert.notEqual(content.length, 0);

        const lines = content
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const entry = lines.find(
          (line) =>
            Array.isArray(line.message) && line.message[0] === "hello from server logger test",
        );
        assert.isDefined(entry);
        const messageParts = entry?.message as unknown[];
        assert.deepEqual(messageParts[1], { threadId: "thread-1" });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("returns undefined and logs a warning when the sink can't be initialized", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-server-log-"));
      const filePath = path.join(tempDir, "server.log");

      try {
        const logger = yield* Effect.scoped(
          makeServerLogFileLogger({
            filePath,
            maxBytes: 0,
            maxFiles: 10,
            batchWindowMs: 60_000,
          }),
        );
        assert.isUndefined(logger);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
