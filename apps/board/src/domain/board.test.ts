import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { parseBoard, serializeBoard, slugify, uniqueSlug } from "./board";

const valid = {
  id: "7f4c2a6e-0d3b-4e3b-9a55-0b7a4c1d2e90",
  slug: "claude-connector",
  name: "Claude connector",
  projectId: "586df7d0-cfc5-44b8-957a-ae03fb872e67",
  orchestratorThreadId: null,
  createdAt: "2026-11-20T06:00:00.000Z",
  archived: false,
  builderCap: 2,
};

describe("parseBoard", () => {
  it("Given a valid board.json, when decoded, then it returns the board", () => {
    const result = parseBoard(JSON.stringify(valid));
    expect(Result.isSuccess(result) && result.success.name).toBe("Claude connector");
  });

  it("Given a board.json whose orchestrator thread is set, when decoded, then it keeps the id", () => {
    const result = parseBoard(JSON.stringify({ ...valid, orchestratorThreadId: "thread:x" }));
    expect(Result.isSuccess(result) && result.success.orchestratorThreadId).toBe("thread:x");
  });

  it("Given a board.json with no name, when decoded, then the error names the name field", () => {
    const { name: _name, ...withoutName } = valid;
    const result = parseBoard(JSON.stringify(withoutName));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.fields).toEqual(["name"]);
      expect(result.failure.message).toContain("name");
    }
  });

  it("Given a board.json with two bad fields, when decoded, then the error names both", () => {
    const result = parseBoard(JSON.stringify({ ...valid, archived: "yes", builderCap: 0 }));
    expect(Result.isFailure(result) && result.failure.fields).toEqual(["archived", "builderCap"]);
  });

  it("Given text that is not JSON, when decoded, then it fails without naming a field", () => {
    const result = parseBoard("{ nope");
    expect(Result.isFailure(result) && result.failure.fields).toEqual([]);
  });

  it("Given a board, when serialized and decoded again, then nothing changes", () => {
    const first = parseBoard(JSON.stringify(valid));
    if (!Result.isSuccess(first)) throw new Error("fixture must decode");
    const again = parseBoard(serializeBoard(first.success));
    expect(Result.isSuccess(again) && again.success).toEqual(first.success);
  });
});

describe("slugify", () => {
  it("Given Claude connector, when slugified, then it is claude-connector", () => {
    expect(slugify("Claude connector")).toBe("claude-connector");
  });

  it("Given accents, symbols, and edge spaces, when slugified, then only letters and digits stay", () => {
    expect(slugify("  Café — v2 / API!  ")).toBe("cafe-v2-api");
  });

  it("Given a name with no letters or digits, when slugified, then it falls back to board", () => {
    expect(slugify("!!!")).toBe("board");
  });

  it("Given a very long name, when slugified, then the slug is cut without a trailing dash", () => {
    const slug = slugify(`${"a".repeat(47)} bbbb`);
    expect(slug).toBe("a".repeat(47));
  });
});

describe("uniqueSlug", () => {
  it("Given no clash, when slugified, then the plain slug is used", () => {
    expect(uniqueSlug("Claude connector", [])).toBe("claude-connector");
  });

  it("Given the slug is taken, when slugified, then it gets the suffix 2", () => {
    expect(uniqueSlug("Claude connector", ["claude-connector"])).toBe("claude-connector-2");
  });

  it("Given 2 is taken too, when slugified, then it gets the suffix 3", () => {
    expect(uniqueSlug("Claude connector", ["claude-connector", "claude-connector-2"])).toBe(
      "claude-connector-3",
    );
  });
});
