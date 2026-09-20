import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LoadMoreCommitsButton } from "./SourceControlPanelRows";

describe("LoadMoreCommitsButton", () => {
  it("shows progress and disables repeated clicks while commits load", () => {
    const markup = renderToStaticMarkup(
      <LoadMoreCommitsButton remaining={24} loading onClick={() => {}} />,
    );

    expect(markup).toContain("Loading...");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("Load 10 more");
  });

  it("describes the next page before loading starts", () => {
    const markup = renderToStaticMarkup(
      <LoadMoreCommitsButton remaining={24} loading={false} onClick={() => {}} />,
    );

    expect(markup).toContain("Load 10 more of 24 remaining");
    expect(markup).not.toContain('disabled=""');
  });
});
