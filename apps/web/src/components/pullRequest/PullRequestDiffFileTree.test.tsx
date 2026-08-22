import type { FileDiffMetadata } from "@pierre/diffs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestDiffFileTree } from "./PullRequestDiffFileTree";

function changedFile(name: string): FileDiffMetadata {
  return { name, type: "change", hunks: [] } as unknown as FileDiffMetadata;
}

describe("PullRequestDiffFileTree", () => {
  it("shows loaded-file progress in the pagination action", () => {
    const markup = renderToStaticMarkup(
      <PullRequestDiffFileTree
        files={[changedFile("src/a.ts"), changedFile("src/b.ts")]}
        totalFileCount={80}
        initiallyExpanded
        hasMore
        isLoadingMore={false}
        loadMoreFailed={false}
        onLoadMore={() => {}}
        onSelectFile={() => {}}
      />,
    );

    expect(markup).toContain("Load more · 2 of 80 loaded");
    expect(markup).toContain("width:2.5%");
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain("all folders");
  });

  it("keeps the current progress visible while the next page loads", () => {
    const markup = renderToStaticMarkup(
      <PullRequestDiffFileTree
        files={[changedFile("src/a.ts"), changedFile("src/b.ts")]}
        totalFileCount={80}
        initiallyExpanded
        hasMore
        isLoadingMore
        loadMoreFailed={false}
        onLoadMore={() => {}}
        onSelectFile={() => {}}
      />,
    );

    expect(markup).toContain("Loading · 2 of 80 loaded");
    expect(markup).toContain('aria-busy="true"');
  });

  it("does not present an exhausted reported count as complete while more files remain", () => {
    const markup = renderToStaticMarkup(
      <PullRequestDiffFileTree
        files={[changedFile("src/a.ts"), changedFile("src/b.ts")]}
        totalFileCount={2}
        initiallyExpanded
        hasMore
        isLoadingMore={false}
        loadMoreFailed={false}
        onLoadMore={() => {}}
        onSelectFile={() => {}}
      />,
    );

    expect(markup).toContain("Load more · 2 loaded");
    expect(markup).not.toContain("2 of 2 loaded");
    expect(markup).not.toContain("width:100%");
  });
});
