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
      name: "relative link in a worktree",
      href: "src/main.ts",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: "src/main.ts",
      full: "/Users/jordan/project/.claude/worktrees/topic/src/main.ts",
    },
    {
      name: "main checkout file outside the thread worktree",
      href: "/Users/jordan/project/src/main.ts",
      cwd: "/Users/jordan/project/.claude/worktrees/topic",
      relative: null,
      full: "/Users/jordan/project/src/main.ts",
    },
    {
      name: "file in a scratch project",
      href: "reports/result.md",
      cwd: "/tmp/scratch",
      relative: "reports/result.md",
      full: "/tmp/scratch/reports/result.md",
    },
    {
      name: "temporary report outside the project",
      href: "/tmp/t3-investigation/report.md",
      cwd: "/Users/jordan/Developer/project",
      relative: null,
      full: "/tmp/t3-investigation/report.md",
    },
    {
      name: "home path outside the project",
      href: "~/.t3/reports/result.md",
      cwd: "/Users/jordan/project",
      relative: null,
      full: "/Users/jordan/.t3/reports/result.md",
    },
    {
      name: "absolute path without a workspace",
      href: "/tmp/report.md",
      cwd: undefined,
      relative: null,
      full: "/tmp/report.md",
    },
    {
      name: "unresolved home path in a scratch project",
      href: "~/.t3/reports/result.md",
      cwd: "/tmp/scratch",
      relative: null,
      full: "~/.t3/reports/result.md",
    },
    {
      name: "absolute path with an empty workspace",
      href: "/tmp/report.md",
      cwd: "",
      relative: null,
      full: "/tmp/report.md",
    },
    {
      name: "encoded spaces",
      href: "reports/Final%20Report.md",
      cwd: "/Users/jordan/project",
      relative: "reports/Final Report.md",
      full: "/Users/jordan/project/reports/Final Report.md",
    },
    {
      name: "angle-bracketed spaces",
      href: "</tmp/scratch/reports/Final Report.md>",
      cwd: "/tmp/scratch",
      relative: "reports/Final Report.md",
      full: "/tmp/scratch/reports/Final Report.md",
    },
    {
      name: "file position",
      href: "src/main.ts:12:3",
      cwd: "/Users/jordan/project",
      relative: "src/main.ts:12:3",
      full: "/Users/jordan/project/src/main.ts:12:3",
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
