import path from "node:path";

import { describe, expect, it } from "vitest";

import { aliasEntriesFromTsconfigPaths } from "./previewAliases.ts";

describe("aliasEntriesFromTsconfigPaths", () => {
  it("maps wildcard aliases to absolute workspace paths", () => {
    expect(
      aliasEntriesFromTsconfigPaths(
        {
          "~/*": ["./src/*"],
          "@/*": ["./src/*"],
        },
        {
          configDir: "/repo/apps/web",
        },
      ),
    ).toEqual([
      { find: "~", replacement: path.resolve("/repo/apps/web", "./src") },
      { find: "@", replacement: path.resolve("/repo/apps/web", "./src") },
    ]);
  });

  it("resolves non-relative targets against baseUrl when present", () => {
    expect(
      aliasEntriesFromTsconfigPaths(
        {
          "@components/*": ["components/*"],
        },
        {
          configDir: "/repo/apps/web",
          baseUrl: "./src",
        },
      ),
    ).toEqual([
      {
        find: "@components",
        replacement: path.resolve("/repo/apps/web", "./src/components"),
      },
    ]);
  });

  it("skips unsupported alias patterns", () => {
    expect(
      aliasEntriesFromTsconfigPaths(
        {
          "@invalid/*/nested": ["./src/*/nested"],
        },
        {
          configDir: "/repo/apps/web",
        },
      ),
    ).toEqual([]);
  });
});
