import { describe, expect, it } from "vite-plus/test";
import { parsePiSessionCommand } from "./piSessionCommands.ts";

describe("Pi session command parsing", () => {
  it("recognizes standalone utilities and an export path with spaces", () => {
    expect(parsePiSessionCommand(" /copy ")).toEqual({ command: "copy" });
    expect(parsePiSessionCommand("/share")).toEqual({ command: "share" });
    expect(parsePiSessionCommand("/export")).toEqual({ command: "export" });
    expect(parsePiSessionCommand("/export reports/my session.html")).toEqual({
      command: "export",
      outputPath: "reports/my session.html",
    });
  });

  it("rejects arguments to no-argument commands instead of treating them as prompts", () => {
    expect(parsePiSessionCommand("/copy this")).toEqual({
      error: "/copy does not accept arguments.",
    });
    expect(parsePiSessionCommand("/share this")).toEqual({
      error: "/share does not accept arguments.",
    });
    expect(parsePiSessionCommand("/copy\nExplain this")).toEqual({
      error: "/copy does not accept arguments.",
    });
    expect(parsePiSessionCommand("/export\nthen explain")).toEqual({
      error: "/export accepts a path on a single line.",
    });
  });

  it("leaves prose and unrecognized commands as prompts", () => {
    for (const prompt of ["please /copy", "/exporter", "/copying"]) {
      expect(parsePiSessionCommand(prompt)).toBeNull();
    }
  });
});
