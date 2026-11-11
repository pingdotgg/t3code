import { describe, expect, it } from "vite-plus/test";

import { findProjectByPath } from "@t3tools/client-runtime/state/projects";

describe("projectPaths", () => {
  it("finds existing projects even when the input formatting differs", () => {
    const existing = findProjectByPath(
      [
        { id: "project-1", cwd: "/repo/app" },
        { id: "project-2", cwd: "C:\\Work\\Repo" },
      ],
      "C:/Work/Repo/",
    );

    expect(existing?.id).toBe("project-2");
  });
});
