import { describe, expect, it } from "vite-plus/test";

import { compareCursorVersions, parseCursorAboutOutput } from "./cli.ts";

describe("Cursor CLI about parsing", () => {
  it("reads version and latest from JSON about output", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          cliVersion: "2026.11.05-86047df",
          latestVersion: "2026.11.06-abcdef0",
          latestStatus: "update_available",
        }),
      }),
    ).toEqual({
      version: "2026.11.05-86047df",
      latestVersion: "2026.11.06-abcdef0",
      latestStatus: "update_available",
    });
  });

  it("reads version and latest from the plain about table", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stderr: "",
        stdout: [
          "About Cursor CLI",
          "",
          "CLI Version         2026.11.05-86047df",
          "Latest              2026.11.06-abcdef0 (update available)",
          "Model               Auto",
        ].join("\n"),
      }),
    ).toEqual({
      version: "2026.11.05-86047df",
      latestVersion: "2026.11.06-abcdef0",
      latestStatus: null,
    });
  });

  it("orders Cursor date builds by calendar day", () => {
    expect(compareCursorVersions("2026.11.05-aaaaaaa", "2026.11.06-bbbbbbb")).toBeLessThan(0);
    expect(compareCursorVersions("2026.11.06-bbbbbbb", "2026.11.05-aaaaaaa")).toBeGreaterThan(0);
    expect(compareCursorVersions("2026.11.05-aaaaaaa", "2026.11.05-aaaaaaa")).toBe(0);
    expect(compareCursorVersions("2026.11.05-aaaaaaa", "2026.11.05-bbbbbbb")).toBeLessThan(0);
  });
});
