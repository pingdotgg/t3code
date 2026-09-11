import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "./diffRendering";
import { createWorkspaceDiff } from "./workspaceDiff";

const patch = `diff --git a/old name.txt b/new name.txt
similarity index 50%
rename from old name.txt
rename to new name.txt
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-before
+after
`;
const environmentId = EnvironmentId.make("test");
function entry(path: string) {
  return {
    repository: { path, name: path, cwd: `/workspace/${path}`, available: true },
    source: {
      id: "branch",
      kind: "branch-range" as const,
      title: "Branch",
      baseRef: `${path}-main`,
      headRef: "HEAD",
      diff: patch,
      diffHash: "same-hash",
      truncated: false,
    },
  };
}

describe("workspace diff", () => {
  it("keeps identical child filenames and hydration cache entries distinct, routing original rename paths", async () => {
    const getContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before", newContents: "after" }),
    );
    const diff = createWorkspaceDiff(
      [entry("projects/one"), entry("projects/two")],
      environmentId,
      getContents,
      "light",
    );
    expect(diff.files.map(resolveFileDiffPath)).toEqual([
      "projects/one/new name.txt",
      "projects/two/new name.txt",
    ]);
    const first = diff.files[0];
    const second = diff.files[1];
    if (!first || !second) throw new Error("Expected two files");
    const one = await diff.loadDiffFiles(first);
    const two = await diff.loadDiffFiles(second);
    expect(first.name).toBe("projects/one/new name.txt");
    expect(one.newFile.name).toBe("projects/one/new name.txt");
    expect(one.oldFile?.name).toBe("projects/one/old name.txt");
    expect(one.newFile.cacheKey).not.toBe(two.newFile.cacheKey);
    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect(getContents.mock.calls).toMatchObject([
      [
        {
          input: {
            cwd: "/workspace/projects/one",
            oldPath: "old name.txt",
            newPath: "new name.txt",
            baseRef: "projects/one-main",
          },
        },
      ],
      [
        {
          input: {
            cwd: "/workspace/projects/two",
            oldPath: "old name.txt",
            newPath: "new name.txt",
            baseRef: "projects/two-main",
          },
        },
      ],
    ]);
  });

  it("preserves wrapper paths and deleted-file hydration", async () => {
    const deleted = `diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`;
    const getContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "gone", newContents: "" }),
    );
    const root = entry(".");
    const diff = createWorkspaceDiff(
      [{ ...root, source: { ...root.source, diff: deleted } }],
      environmentId,
      getContents,
      "light",
    );
    const file = diff.files[0];
    if (!file) throw new Error("Expected deleted file");
    expect(resolveFileDiffPath(file)).toBe("gone.txt");
    await diff.loadDiffFiles(file);
    expect(getContents.mock.calls).toMatchObject([
      [{ input: { oldPath: "gone.txt", newPath: "gone.txt", changeType: "deleted" } }],
    ]);
    expect(getRenderablePatch(deleted)?.kind).toBe("files");
  });
  it("keeps valid repositories visible when another patch cannot be parsed", () => {
    const getContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "", newContents: "" }),
    );
    const broken = entry("projects/broken");
    const diff = createWorkspaceDiff(
      [
        entry("projects/valid"),
        { ...broken, source: { ...broken.source, diff: "unrecognized patch format" } },
      ],
      environmentId,
      getContents,
      "light",
    );
    expect(diff.files).toHaveLength(1);
    expect(diff.warnings).toEqual([expect.stringContaining("projects/broken:")]);
    expect(diff.rawPatch?.text).toContain(`Repository: projects/valid\n${patch}`);
    expect(diff.rawPatch?.text).toContain("Repository: projects/broken\nunrecognized patch format");
  });
  it("preserves a/ and b/ workspace prefixes through hydration without route collisions", async () => {
    const getContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before", newContents: "after" }),
    );
    const paths = ["a/service", "b/service", "service"];
    const diff = createWorkspaceDiff(paths.map(entry), environmentId, getContents, "light");
    expect(new Set(diff.files.map(buildFileDiffIdentityKey)).size).toBe(paths.length);
    for (const [index, file] of diff.files.entries()) {
      expect(resolveFileDiffPath(file)).toBe(`${paths[index]}/new name.txt`);
      expect(resolveFileDiffPreviousPath(file)).toBe(`${paths[index]}/old name.txt`);
      const loaded = await diff.loadDiffFiles(file);
      expect(loaded.newFile.name).toBe(`${paths[index]}/new name.txt`);
      expect(loaded.oldFile?.name).toBe(`${paths[index]}/old name.txt`);
    }
    expect(getContents.mock.calls).toMatchObject(
      paths.map((path) => [{ input: { cwd: `/workspace/${path}` } }]),
    );
  });
});
