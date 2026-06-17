import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";

describe("ComposerPendingReviewComments", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a removable file comment pill", async () => {
    const onRemove = vi.fn();
    const screen = await render(
      <ComposerPendingReviewComments
        comments={[
          {
            id: "comment-1",
            sectionId: "file:src/app.ts",
            sectionTitle: "File comment",
            filePath: "src/app.ts",
            startIndex: 1,
            endIndex: 2,
            rangeLabel: "L2 to L3",
            text: "Keep this configurable.",
            diff: "@@ -2,2 +2,2 @@\n two\n three",
          },
        ]}
        onRemove={onRemove}
      />,
    );

    await expect.element(page.getByText("src/app.ts L2 to L3")).toBeVisible();
    await page.getByRole("button", { name: "Remove comment on src/app.ts L2 to L3" }).click();
    expect(onRemove).toHaveBeenCalledWith("comment-1");

    await screen.unmount();
  });
});
