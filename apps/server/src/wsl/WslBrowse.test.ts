import { describe, expect, it } from "vitest";

import { parseWslBrowseOutput } from "./WslBrowse.ts";

describe("parseWslBrowseOutput", () => {
  it("parses nul-delimited WSL directory browse output", () => {
    expect(
      parseWslBrowseOutput(
        [
          "/home/me",
          "__PREFIX__:pr",
          "__ENTRY__:project:/home/me/project",
          "__ENTRY__:notes:/home/me/notes",
        ].join("\n"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [{ name: "project", fullPath: "/home/me/project" }],
    });
  });

  it("hides dot directories unless the prefix requests them", () => {
    expect(
      parseWslBrowseOutput(
        [
          "/home/me",
          "__PREFIX__:",
          "__ENTRY__:.config:/home/me/.config",
          "__ENTRY__:src:/home/me/src",
        ].join("\n"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [
        { name: ".config", fullPath: "/home/me/.config" },
        { name: "src", fullPath: "/home/me/src" },
      ],
    });

    expect(
      parseWslBrowseOutput(
        [
          "/home/me",
          "__PREFIX__:s",
          "__ENTRY__:.ssh:/home/me/.ssh",
          "__ENTRY__:src:/home/me/src",
        ].join("\n"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [{ name: "src", fullPath: "/home/me/src" }],
    });
  });

  it("throws when parent path is missing", () => {
    expect(() => parseWslBrowseOutput("")).toThrow("parent path");
  });
});
