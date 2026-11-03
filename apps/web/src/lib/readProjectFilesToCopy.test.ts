import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ executeAtomQuery: vi.fn() }));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  squashAtomCommandFailure: (result: { error: Error }) => result.error,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    listEntries: (request: object) => ({ method: "list", ...request }),
    readFile: (request: object) => ({ method: "read", ...request }),
  },
}));

import { readProjectFilesToCopy } from "./readProjectFilesToCopy";

const source = { environmentId: EnvironmentId.make("source"), cwd: "/workspace" };

function setup() {
  mocks.executeAtomQuery.mockReset();
  const readPaths: string[] = [];
  const listedPaths: string[] = [];
  const directories = new Map([
    [
      ".local",
      [
        { path: ".local/config.json", kind: "file" },
        { path: ".local/nested", kind: "directory" },
      ],
    ],
    [".local/nested", [{ path: ".local/nested/token", kind: "file" }]],
    [".agents", [{ path: ".agents/skills", kind: "directory" }]],
    [".agents/skills", [{ path: ".agents/skills/example", kind: "directory" }]],
    [
      ".agents/skills/example",
      [
        { path: ".agents/skills/example/SKILL.md", kind: "file" },
        { path: ".agents/skills/example/helper.sh", kind: "file" },
      ],
    ],
  ]);
  mocks.executeAtomQuery.mockImplementation(async (_registry, query) => {
    expect(query.environmentId).toBe(source.environmentId);
    expect(query.input.cwd).toBe(source.cwd);
    if (query.method === "list") {
      listedPaths.push(query.input.directoryPath);
      return {
        _tag: "Success",
        value: {
          entries: directories.get(query.input.directoryPath) ?? [],
          truncated: false,
        },
      };
    }
    readPaths.push(query.input.relativePath);
    return {
      _tag: "Success",
      value: {
        contents: `contents:${query.input.relativePath}`,
        truncated: false,
        ...(query.input.includeMode && query.input.relativePath.endsWith("helper.sh")
          ? { mode: 0o755 }
          : {}),
      },
    };
  });
  return { readPaths, listedPaths };
}

describe("readProjectFilesToCopy", () => {
  it("reads selected ignored folders recursively and keeps paths for the destination", async () => {
    const { readPaths, listedPaths } = setup();

    const result = await readProjectFilesToCopy(source, [".env", ".local/", ".agents/"]);

    expect(listedPaths).toEqual([
      ".local",
      ".agents",
      ".local/nested",
      ".agents/skills",
      ".agents/skills/example",
    ]);
    expect(readPaths.toSorted()).toEqual([
      ".agents/skills/example/SKILL.md",
      ".agents/skills/example/helper.sh",
      ".env",
      ".local/config.json",
      ".local/nested/token",
    ]);
    expect(result).toEqual(
      expect.arrayContaining(
        readPaths.map((relativePath) => ({
          relativePath,
          contents: `contents:${relativePath}`,
          ...(relativePath.endsWith("helper.sh") ? { mode: 0o755 } : {}),
        })),
      ),
    );
    expect(result).toHaveLength(5);
  });

  it("does not enumerate unselected folders", async () => {
    const { readPaths, listedPaths } = setup();

    await readProjectFilesToCopy(source, [".env", ".env"]);

    expect(listedPaths).toEqual([]);
    expect(readPaths).toEqual([".env"]);
  });

  it("reads overlapping file and folder selections once", async () => {
    const { readPaths, listedPaths } = setup();

    await readProjectFilesToCopy(source, [".local/", ".local/nested/", ".local/config.json"]);

    expect(listedPaths).toEqual([".local", ".local/nested"]);
    expect(readPaths.toSorted()).toEqual([".local/config.json", ".local/nested/token"]);
  });

  it("reports a folder listing failure", async () => {
    setup();
    mocks.executeAtomQuery.mockResolvedValue({
      _tag: "Failure",
      error: new Error("Folder is unavailable."),
    });

    await expect(readProjectFilesToCopy(source, [".local/"])).rejects.toThrow(
      "Folder is unavailable.",
    );
  });

  it.each([
    {
      reason: "truncated",
      truncated: true,
      skippedPaths: [],
      message: "Could not list every file in .local/.",
    },
    {
      reason: "unsupported",
      truncated: false,
      skippedPaths: [".local/skills"],
      message: "Cannot copy unsupported entry .local/skills.",
    },
  ])(
    "rejects $reason folder listings instead of copying a partial folder",
    async ({ truncated, skippedPaths, message }) => {
      setup();
      mocks.executeAtomQuery.mockImplementation(async (_registry, query) => ({
        _tag: "Success",
        value: {
          entries: [{ path: ".local/config.json", kind: "file" }],
          truncated,
          ...(query.input.reportSkipped ? { skippedPaths } : {}),
        },
      }));

      await expect(readProjectFilesToCopy(source, [".local/"])).rejects.toThrow(message);
    },
  );

  it("rejects folder expansion beyond 200 entries before reading contents", async () => {
    setup();
    const readPaths: string[] = [];
    mocks.executeAtomQuery.mockImplementation(async (_registry, query) => {
      if (query.method === "list") {
        return {
          _tag: "Success",
          value: {
            entries: Array.from({ length: 201 }, (_, index) => ({
              path: `.local/${index}.txt`,
              kind: "file",
            })),
            truncated: false,
          },
        };
      }
      readPaths.push(query.input.relativePath);
      return { _tag: "Success", value: { contents: "file", truncated: false } };
    });

    await expect(readProjectFilesToCopy(source, [".local/"])).rejects.toThrow(
      "Copy at most 200 files and folders at a time.",
    );
    expect(readPaths).toEqual([]);
  });

  it("retains file read failures and rejects oversized contents", async () => {
    setup();
    mocks.executeAtomQuery
      .mockResolvedValueOnce({ _tag: "Failure", error: new Error("Cannot read file.") })
      .mockResolvedValueOnce({ _tag: "Success", value: { contents: "partial", truncated: true } });

    expect(await readProjectFilesToCopy(source, [".env", "large.log"])).toEqual([
      { relativePath: ".env", error: "Cannot read file." },
      { relativePath: "large.log", error: "Too large to copy." },
    ]);
  });

  it.each([false, true])(
    "stops reading beyond 20 MiB of UTF-8 content (truncated: %s)",
    async (truncated) => {
      setup();
      const paths = Array.from({ length: 25 }, (_, index) => `.local/${index}.txt`);
      const contents = "é".repeat(512 * 1024);
      const readPaths: string[] = [];
      mocks.executeAtomQuery.mockImplementation(async (_registry, query) => {
        if (query.method === "list") {
          return {
            _tag: "Success",
            value: { entries: paths.map((path) => ({ path, kind: "file" })), truncated: false },
          };
        }
        readPaths.push(query.input.relativePath);
        return { _tag: "Success", value: { contents, truncated } };
      });

      await expect(
        readProjectFilesToCopy(source, [".local/"]).then((reads) => reads.length),
      ).rejects.toThrow("Copy at most 20 MB of file contents at a time.");
      expect(readPaths.length).toBeLessThan(paths.length);
    },
  );

  it("limits concurrent file reads when a folder contains many files", async () => {
    setup();
    const paths = Array.from({ length: 9 }, (_, index) => `.local/${index}.txt`);
    let markFirstBatch = () => {};
    const firstBatch = new Promise<void>((resolve) => {
      markFirstBatch = resolve;
    });
    let releaseReads = () => {};
    const released = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let activeReads = 0;
    let maxActiveReads = 0;
    mocks.executeAtomQuery.mockImplementation(async (_registry, query) => {
      if (query.method === "list") {
        return {
          _tag: "Success",
          value: { entries: paths.map((path) => ({ path, kind: "file" })), truncated: false },
        };
      }
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (activeReads === 4) markFirstBatch();
      await released;
      activeReads--;
      return { _tag: "Success", value: { contents: "file", truncated: false } };
    });

    const reading = readProjectFilesToCopy(source, [".local/"]);
    await firstBatch;
    releaseReads();

    expect(await reading).toHaveLength(paths.length);
    expect(maxActiveReads).toBe(4);
  });
});
