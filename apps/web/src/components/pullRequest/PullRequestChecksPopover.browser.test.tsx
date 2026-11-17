import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";

it("labels the checks trigger with a translated summary, not a raw key", async () => {
  await using screen = await render(<PullRequestChecksPopover checksState="passing" />);
  await expect
    .element(screen.getByRole("button", { name: "Checks: All checks have passed" }))
    .toBeVisible();
});
