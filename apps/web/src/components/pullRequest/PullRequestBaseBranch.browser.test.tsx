import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PullRequestBaseBranch } from "./PullRequestBaseBranch";

it("updates with the only offered method from the out-of-date warning", async () => {
  const onUpdate = vi.fn();
  await using screen = await render(
    <PullRequestBaseBranch
      baseBranch="main"
      freshness={{ behindBy: 3, methods: ["rebase"] }}
      stacked={false}
      pending={false}
      onUpdate={onUpdate}
    />,
    // The base branch control renders no links and reads no route.
    { router: false },
  );
  await screen.getByRole("button", { name: "Update with rebase" }).click();
  expect(onUpdate).toHaveBeenCalledExactlyOnceWith("rebase");
});

it("offers merge commit and rebase when both update methods are available", async () => {
  const onUpdate = vi.fn();
  await using screen = await render(
    <PullRequestBaseBranch
      baseBranch="main"
      freshness={{ behindBy: 1, methods: ["merge", "rebase"] }}
      stacked={false}
      pending={false}
      onUpdate={onUpdate}
    />,
    // The base branch control renders no links and reads no route.
    { router: false },
  );
  await screen.getByRole("button", { name: "Update branch from base" }).click();
  await page.getByRole("menuitem", { name: "Update with merge commit" }).click();
  expect(onUpdate).toHaveBeenCalledWith("merge");
});
