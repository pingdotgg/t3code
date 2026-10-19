import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownFileLinkMeta } from "../markdown-links";

import {
  canUseMarkdownFileShellActions,
  markdownFileCopyMenuItems,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions only for resolved local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  const html = { iconPath: "/tmp/report.html", canOpenInBrowser: true };

  it("uses the browser only when it is the sole action, except for PDFs", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: true,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

describe("markdownFileCopyMenuItems", () => {
  it.each([
    {
      name: "project file",
      href: "/Users/jordan/project/src/main.ts",
      cwd: "/Users/jordan/project",
      relative: "src/main.ts",
      full: "/Users/jordan/project/src/main.ts",
    },
    {
      name: "worktree file with a line and column",
      href: "src/main.ts:12:3",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: "src/main.ts:12:3",
      full: "/Users/jordan/project/.claude/worktrees/topic/src/main.ts:12:3",
    },
    {
      name: "main checkout file outside the thread worktree",
      href: "/Users/jordan/project/src/main.ts",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: null,
      full: "/Users/jordan/project/src/main.ts",
    },
  ])("offers accurate clipboard values for $name", ({ href, cwd, relative, full }) => {
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    expect(meta).not.toBeNull();
    if (!meta) throw new Error(`Expected a file link for ${href}`);

    expect(markdownFileCopyMenuItems(meta)).toEqual([
      ...(relative === null
        ? []
        : [
            {
              id: "copy-relative",
              label: "Copy relative path",
              value: relative,
              title: "Relative path",
            },
          ]),
      {
        id: "copy-full",
        label: "Copy full path",
        value: full,
        title: "Full path",
      },
    ]);
  });
});
