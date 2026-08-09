import { describe, expect, it } from "@effect/vitest";

import { parseTerminalServerFrame } from "./terminalConnection.ts";

describe("parseTerminalServerFrame", () => {
  it("parses an output frame on the terminal channel", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "output", sessionId: "term-1", data: "hello" }),
      ),
    ).toEqual({ _tag: "output", sessionId: "term-1", data: "hello" });
  });

  it("parses a close frame", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "close", sessionId: "term-1" }),
      ),
    ).toEqual({ _tag: "close", sessionId: "term-1" });
  });

  it("ignores frames on other channels", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "ports", type: "snapshot", ports: [3000] }),
      ),
    ).toEqual({ _tag: "ignored" });
  });

  it("ignores a terminal output frame missing its data (never drops silently as output)", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "output", sessionId: "x" }),
      ),
    ).toEqual({ _tag: "ignored" });
  });

  it("ignores non-JSON and non-object payloads", () => {
    expect(parseTerminalServerFrame("not json")).toEqual({ _tag: "ignored" });
    expect(parseTerminalServerFrame("null")).toEqual({ _tag: "ignored" });
    expect(parseTerminalServerFrame("42")).toEqual({ _tag: "ignored" });
  });
});
