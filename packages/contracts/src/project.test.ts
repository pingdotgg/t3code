import { describe, expect, it } from "vitest";

import {
  projectAddInputSchema,
  projectAddResultSchema,
  projectSearchEntriesInputSchema,
  projectSearchEntriesResultSchema,
  projectListResultSchema,
  projectRemoveInputSchema,
  projectUpdateScriptsInputSchema,
  projectUpdateScriptsResultSchema,
} from "./project";

describe("project contracts", () => {
  it("parses project list result", () => {
    const result = projectListResultSchema.parse([
      {
        id: "project-1",
        cwd: "/tmp/project",
        name: "project",
        scripts: [],
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
        scripts: [],
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

  it("parses workspace entry search input with defaults", () => {
    const parsed = projectSearchEntriesInputSchema.parse({
      cwd: "  /tmp/project  ",
      query: "  src  ",
    });

    expect(parsed).toEqual({
      cwd: "/tmp/project",
      query: "src",
      limit: 80,
    });
  });

  it("parses workspace entry search result", () => {
    const parsed = projectSearchEntriesResultSchema.parse({
      entries: [
        {
          path: "src/components",
          kind: "directory",
          parentPath: "src",
        },
        {
          path: "src/components/Button.tsx",
          kind: "file",
          parentPath: "src/components",
        },
      ],
      truncated: false,
    });

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.kind).toBe("directory");
  });

  it("parses update scripts input", () => {
    const parsed = projectUpdateScriptsInputSchema.parse({
      id: "project-1",
      scripts: [
        {
          id: "test",
          name: "Test",
          command: "bun test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.id).toBe("test");
  });

  it("parses debug icon in scripts", () => {
    const parsed = projectUpdateScriptsInputSchema.parse({
      id: "project-1",
      scripts: [
        {
          id: "debug",
          name: "Debug",
          command: "bun --inspect test",
          icon: "debug",
          runOnWorktreeCreate: false,
        },
      ],
    });

    expect(parsed.scripts[0]?.icon).toBe("debug");
  });

  it("parses update scripts result", () => {
    const parsed = projectUpdateScriptsResultSchema.parse({
      project: {
        id: "project-1",
        cwd: "/tmp/project",
        name: "project",
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
    });

    expect(parsed.project.scripts[0]?.id).toBe("setup");
  });
});
