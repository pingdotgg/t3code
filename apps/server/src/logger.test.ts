import { Writable } from "node:stream";

import type { DestinationStream } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger";

function createCaptureStream() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as DestinationStream;

  return {
    output: () => output,
    stream,
  };
}

describe("createLogger", () => {
  it("writes structured JSON with scope and event metadata", () => {
    const capture = createCaptureStream();
    const logger = createLogger("ws", {
      destination: capture.stream,
    });

    logger.event("outgoing push", {
      channel: "orchestration.domainEvent",
      payload: { ok: true },
      recipients: 2,
      sequence: 7,
    });

    const line = capture.output().trim();
    expect(line).not.toBe("");

    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry).toMatchObject({
      channel: "orchestration.domainEvent",
      level: 30,
      msg: "outgoing push",
      payload: { ok: true },
      recipients: 2,
      scope: "ws",
      sequence: 7,
      type: "event",
    });
    expect(typeof entry.time).toBe("string");
    expect(Number.isNaN(Date.parse(String(entry.time)))).toBe(false);
  });

  it("configures pino-pretty for interactive development sessions", () => {
    const capture = createCaptureStream();
    const prettyFactory = vi.fn(() => capture.stream);
    const logger = createLogger("terminal", {
      isTty: true,
      nodeEnv: "development",
      prettyFactory,
    });

    logger.info("started");

    expect(prettyFactory).toHaveBeenCalledTimes(1);
    expect(prettyFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        ignore: "pid,hostname,scope",
        messageFormat: "{if scope}[{scope}] {end}{msg}",
        singleLine: true,
        translateTime: "SYS:HH:MM:ss.l",
      }),
    );
    expect(capture.output()).toContain('"msg":"started"');
  });
});
