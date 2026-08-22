import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FileDiffMetadata } from "@pierre/diffs";

const testState = vi.hoisted(() => ({
  codeViewClassName: null as string | null,
  codeViewOptions: null as Record<string, unknown> | null,
  fileDiffClassName: null as string | null,
  fileDiffOptions: null as Record<string, unknown> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: { className: string; options: Record<string, unknown> }) => {
    testState.codeViewClassName = props.className;
    testState.codeViewOptions = props.options;
    return null;
  },
  FileDiff: (props: { className: string; options: Record<string, unknown> }) => {
    testState.fileDiffClassName = props.className;
    testState.fileDiffOptions = props.options;
    return null;
  },
}));

import { StyledDiffCodeView, StyledFileDiff } from "./StyledDiffCodeView";

describe("StyledDiffCodeView", () => {
  beforeEach(() => {
    testState.codeViewClassName = null;
    testState.codeViewOptions = null;
    testState.fileDiffClassName = null;
    testState.fileDiffOptions = null;
  });

  it("always pairs the shared diff styling with its virtualized geometry", () => {
    const loadDiffFiles = vi.fn(async () => ({
      oldFile: { name: "before.ts", contents: "before\n" },
      newFile: { name: "after.ts", contents: "after\n" },
    }));
    renderToStaticMarkup(
      <StyledDiffCodeView
        className="min-h-0"
        items={[]}
        options={{ theme: "pierre-dark", stickyHeaders: true, loadDiffFiles }}
      />,
    );

    expect(testState.codeViewClassName).toBe(
      "diff-render-surface [--code-background:var(--background)] outline-none " +
        "[--t3-diff-addition-color:var(--success)] " +
        "[--t3-diff-deletion-color:var(--destructive)] min-h-0",
    );
    expect(testState.codeViewOptions).toMatchObject({
      theme: "pierre-dark",
      stickyHeaders: true,
      loadDiffFiles,
      diffIndicators: "bars",
      itemMetrics: {
        diffHeaderHeight: 32,
        hunkSeparatorHeight: 24,
        paddingTop: 0,
        paddingBottom: 8,
      },
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    });
    expect(testState.codeViewOptions?.unsafeCSS).toEqual(
      expect.stringContaining("[data-unmodified-lines]::before"),
    );
    expect(testState.codeViewOptions?.unsafeCSS).toEqual(
      expect.stringContaining(")[data-expand-index]\n  [data-unmodified-lines]"),
    );
  });

  it("applies the shared appearance to standalone file diffs", () => {
    const fileDiff = { name: "src/app.ts", hunks: [] } as unknown as FileDiffMetadata;
    renderToStaticMarkup(
      <StyledFileDiff
        className="rounded-md"
        fileDiff={fileDiff}
        options={{ collapsed: false, theme: "pierre-dark" }}
      />,
    );

    expect(testState.fileDiffClassName).toBe(
      "diff-render-surface [--code-background:var(--background)] outline-none " +
        "[--t3-diff-addition-color:var(--success)] " +
        "[--t3-diff-deletion-color:var(--destructive)] rounded-md",
    );
    expect(testState.fileDiffOptions).toMatchObject({
      collapsed: false,
      theme: "pierre-dark",
      diffIndicators: "bars",
    });
    expect(testState.fileDiffOptions?.unsafeCSS).toEqual(
      expect.stringContaining("--diffs-addition-base"),
    );
  });
});
