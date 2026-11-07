import "~/index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ExpandableText } from "./ExpandableText";

const LONG_SINGLE_LINE_ERROR =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

it("shows no disclosure when a long error fits within the clamp", async () => {
  await using screen = await render(
    <div style={{ width: 960 }}>
      <ExpandableText text={LONG_SINGLE_LINE_ERROR} />
    </div>,
  );

  await expect.element(screen.getByText(LONG_SINGLE_LINE_ERROR)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Show full error" }))
    .not.toBeInTheDocument();
});

it("offers the disclosure when the error is clipped by the clamp", async () => {
  await using screen = await render(
    <div style={{ width: 200 }}>
      <ExpandableText text={LONG_SINGLE_LINE_ERROR} />
    </div>,
  );

  await expect.element(screen.getByRole("button", { name: "Show full error" })).toBeVisible();
});
