import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ExpandableText } from "./ExpandableText";

const ERROR =
  "Cannot restore files because the shared workspace has uncommitted changes from another thread. Commit, stash or discard them first, then try reverting this checkpoint again from the thread.";

describe("ExpandableText", () => {
  it.each([
    { width: 900, offersExpansion: false },
    { width: 120, offersExpansion: true },
  ])("at $width px offers expansion: $offersExpansion", async ({ width, offersExpansion }) => {
    await using screen = await render(
      <div style={{ width, font: "14px/20px sans-serif" }}>
        <ExpandableText text={ERROR} />
      </div>,
    );

    await expect.element(screen.getByText(ERROR)).toBeVisible();
    const control = screen.getByRole("button", { name: "Show full error" });
    if (offersExpansion) await expect.element(control).toBeVisible();
    else await expect.element(control).not.toBeInTheDocument();
  });
});
