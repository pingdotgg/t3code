import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownFileLinkMeta } from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

const CWD = "E:\\Programming\\hogwarts-productivity-hub-bot";

// A link such as [user.ts:261](user.ts:261), as the agent writes it.
function chipMeta(href: string) {
  const meta = resolveMarkdownFileLinkMeta(href, CWD);
  if (meta === null) throw new Error(`not a file chip: ${href}`);
  return meta;
}

describe("resolveMarkdownFileHostPath", () => {
  it("opens and copies a bare filename where the workspace index finds it", async () => {
    const meta = chipMeta("user.ts:261");
    const queries: string[] = [];
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd: CWD,
      findWorkspaceMatch: async (relativePath) => {
        queries.push(relativePath);
        return "src/discord/events/interactionCreate/user.ts";
      },
    });

    expect(queries).toEqual(["user.ts"]);
    expect(hostPath.absolutePath).toBe(
      "E:\\Programming\\hogwarts-productivity-hub-bot\\src\\discord\\events\\interactionCreate\\user.ts",
    );
    expect(markdownFileEditorTarget(meta, hostPath)).toBe(`${hostPath.absolutePath}:261`);
    expect(markdownFileCopyPaths(meta, hostPath, CWD)).toEqual({
      fullPath: `${hostPath.absolutePath}:261`,
      // The same workspace-labelled form the chip shows for a link it can place.
      relativePath:
        "hogwarts-productivity-hub-bot/src/discord/events/interactionCreate/user.ts:261",
    });
  });

  it("keeps the link's own paths when the index has no match", async () => {
    const meta = chipMeta("missing.ts");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd: CWD,
      findWorkspaceMatch: async () => null,
    });

    expect(hostPath).toEqual({ absolutePath: meta.filePath, matched: false });
    expect(markdownFileEditorTarget(meta, hostPath)).toBe(meta.targetPath);
    expect(markdownFileCopyPaths(meta, hostPath, CWD)).toEqual({
      fullPath: meta.targetPath,
      relativePath: meta.displayPath,
    });
  });
});
