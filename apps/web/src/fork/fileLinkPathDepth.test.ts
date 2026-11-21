import type { FileLinkPathDepth } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileLinkPathPrefix } from "./fileLinkPathDepth";

type Meta = Parameters<typeof fileLinkPathPrefix>[0];

const inWorkspace = (workspaceRelativePath: string): Meta => ({
  filePath: `/home/me/project/${workspaceRelativePath}`,
  workspaceRelativePath,
});
const outside = (filePath: string): Meta => ({ filePath, workspaceRelativePath: null });
const collisions = new Map([
  ["/home/me/project/src/web/index.ts", "src/web"],
  ["C:/repo/src/server/index.ts", "src/server"],
]);

describe("fileLinkPathPrefix", () => {
  it.each<[string, Meta, FileLinkPathDepth, string | undefined]>([
    ["depth 1 shows no folder", inWorkspace("docs/review-pipeline/glossary.md"), 1, undefined],
    ["depth 2", inWorkspace("docs/review-pipeline/glossary.md"), 2, "review-pipeline/"],
    ["depth 3", inWorkspace("docs/review-pipeline/glossary.md"), 3, "docs/review-pipeline/"],
    ["a workspace root file", inWorkspace("README.md"), 3, undefined],
    ["fewer folders than the depth", inWorkspace("docs/glossary.md"), 5, "docs/"],
    [
      "an absolute path outside the workspace",
      outside("/etc/nginx/sites/app.conf"),
      3,
      "nginx/sites/",
    ],
    ["a POSIX name with a backslash", outside("/tmp/notes/a\\b.md"), 2, undefined],
    ["a workspace folder named like a drive", inWorkspace("C:/docs/a.md"), 3, "C:/docs/"],
    ["a slash-prefixed Windows drive path", outside("/C:/Users/me/notes.md"), 3, "Users/me/"],
    ["a Windows drive path", outside("C:\\Users\\me\\notes.md"), 4, "Users/me/"],
    ["a UNC path", outside("\\\\server\\share\\docs\\a.md"), 3, "share/docs/"],
    ["folders after the last ..", outside("../../shared/lib/util.ts"), 4, "shared/lib/"],
    ["a dot folder", outside("./src/./app.ts"), 3, "src/"],
    ["a colliding path", inWorkspace("src/web/index.ts"), 3, undefined],
    ["a colliding Windows path", outside("C:\\repo\\src\\server\\index.ts"), 3, undefined],
  ])("%s", (_name, meta, depth, expected) => {
    expect(fileLinkPathPrefix(meta, collisions, depth)).toBe(expected);
  });
});
