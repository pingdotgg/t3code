import { describe, expect, it } from "vitest";

import {
  projectAddInputSchema,
  projectAddResultSchema,
  projectListResultSchema,
  projectRemoveInputSchema,
} from "./project";

describe("project contracts", () => {
  it("parses project list result", () => {
    const result = projectListResultSchema.parse([
      {
        id: "project-1",
        cwd: "/tmp/project",
        name: "project",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("project-1");
  });

  it("trims add input cwd", () => {
    const parsed = projectAddInputSchema.parse({ cwd: "  /tmp/project  " });
    expect(parsed.cwd).toBe("/tmp/project");
  });

  it("requires add result created flag", () => {
    const parsed = projectAddResultSchema.parse({
      project: {
        id: "project-1",
        cwd: "/tmp/project",
        name: "project",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      created: true,
    });
    expect(parsed.created).toBe(true);
  });

  it("parses remove input", () => {
    const parsed = projectRemoveInputSchema.parse({ id: "project-1" });
    expect(parsed.id).toBe("project-1");
  });
});
