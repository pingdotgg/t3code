import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerTasksBadge } from "./ComposerTasksBadge";

describe("ComposerTasksBadge", () => {
  it("expands the current task into a status list and collapses again", async () => {
    render(
      <ComposerTasksBadge
        steps={[
          { step: "Explore repo and identify 10 performance improvements", status: "inProgress" },
          { step: "Select highest-impact lowest-effort fix and implement", status: "pending" },
          { step: "Run checks and open PR", status: "pending" },
        ]}
      />,
    );

    const toggle = page.getByRole("button", { name: /Tasks: 0 of 3 complete/ });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByText("Select highest-impact lowest-effort fix and implement"))
      .not.toBeInTheDocument();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByRole("list", { name: /Task list/ })).toBeVisible();
    await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Pending", { exact: true }).first()).toBeVisible();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("list", { name: /Task list/ })).not.toBeInTheDocument();
  });
});
