import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { parseCommandCodeNdjsonLine } from "./Layers/CommandCodeAdapter.ts";

const fixtureLines = (name: string): ReadonlyArray<string> =>
  readFileSync(
    new URL(`./testFixtures/commandCodeHeadless/${name}`, import.meta.url),
    "utf8",
  ).split(/\r?\n/);

describe("parseCommandCodeNdjsonLine", () => {
  it("classifies event frames and ignores junk", () => {
    const frame = parseCommandCodeNdjsonLine(
      '{"type":"event","event":{"type":"tool_running","toolCallId":"c1","toolName":"read_file"}}',
    );
    expect(frame.kind).toBe("frame");
    expect(frame.kind === "frame" ? frame.frame["type"] : "").toBe("tool_running");

    expect(parseCommandCodeNdjsonLine("").kind).toBe("skip");
    expect(parseCommandCodeNdjsonLine("not json").kind).toBe("skip");
    expect(parseCommandCodeNdjsonLine('{"type":"wat"}').kind).toBe("skip");
  });

  it("classifies the final result line", () => {
    const parsed = parseCommandCodeNdjsonLine(
      '{"type":"result","subtype":"success","sessionId":"abc-123","usage":{"inputTokens":10}}',
    );
    expect(parsed.kind).toBe("result");
    if (parsed.kind === "result") {
      expect(parsed.result.subtype).toBe("success");
      expect(parsed.result.sessionId).toBe("abc-123");
    }
  });
});

describe("captured headless transcript fixtures", () => {
  it("text turn: starts with run_start and ends with a success result", () => {
    const lines = fixtureLines("turn-text-success.ndjson");
    const parsed = lines.map(parseCommandCodeNdjsonLine);

    const firstFrame = parsed.find((entry) => entry.kind === "frame");
    expect(firstFrame?.kind === "frame" ? firstFrame.frame["type"] : "").toBe("run_start");

    const results = parsed.filter((entry) => entry.kind === "result");
    expect(results).toHaveLength(1);
    if (results[0]?.kind === "result") {
      expect(results[0].result.subtype).toBe("success");
      expect(typeof results[0].result.sessionId).toBe("string");
    }
  });

  it("tool turn exposes tool lifecycle frames", () => {
    const lines = fixtureLines("turn-with-tools.ndjson");
    const frameTypes = lines
      .map(parseCommandCodeNdjsonLine)
      .filter(
        (
          entry,
        ): entry is Extract<ReturnType<typeof parseCommandCodeNdjsonLine>, { kind: "frame" }> =>
          entry.kind === "frame",
      )
      .map((entry) => entry.frame["type"] as string);

    for (const expected of ["tool_queued", "tool_running", "tool_completed"]) {
      expect(frameTypes).toContain(expected);
    }
    expect(frameTypes[0]).toBe("run_start");
  });

  it("resumed turn keeps context (usage grows) and returns the same session", () => {
    const resumed = fixtureLines("turn-resume-success.ndjson");
    const result = resumed
      .map(parseCommandCodeNdjsonLine)
      .find((entry) => entry.kind === "result" && entry.result.subtype === "success");
    expect(result?.kind === "result" ? result.result.sessionId : undefined).toBe(
      "70f4e0db-f3d6-439f-b7f3-dfb935b30ef1",
    );
  });

  it("an unknown-model failure writes no NDJSON result, only stderr", () => {
    const stderr = readFileSync(
      new URL("./testFixtures/commandCodeHeadless/error-bad-model.stderr.txt", import.meta.url),
      "utf8",
    );
    expect(stderr).toMatch(/unknown model/);
  });
});
