import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerTasksBadge } from "./ComposerTasksBadge";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("ComposerTasksBadge", () => {
  it("keeps completed tasks visible until the turn settles", async () => {
    render(
      <ComposerTasksBadge
        steps={[
          { step: "Inspect the repository", status: "completed" },
          { step: "Finish the change", status: "completed" },
        ]}
      />,
    );

    const toggle = page.getByRole("button", { name: /Tasks: 2 of 2 complete/ });
    await expect.element(toggle).toBeVisible();
    await expect.element(toggle).toHaveTextContent("2/2 complete");

    await toggle.click();
    await expect
      .element(page.getByRole("list", { name: /Task list. 2 of 2 complete/ }))
      .toBeVisible();
    await expect.element(page.getByRole("listitem").first()).toHaveTextContent("Completed");
    await expect.element(page.getByRole("listitem").last()).toHaveTextContent("Completed");
  });

  it("uses the upstream near-black raised surface in dark mode", async () => {
    document.documentElement.classList.add("dark");
    render(
      <form data-chat-composer-form="true">
        <ComposerTasksBadge steps={[{ step: "Inspect colors", status: "inProgress" }]} />
      </form>,
    );

    await expect
      .element(page.getByRole("button", { name: /Tasks: 0 of 1 complete/ }))
      .toBeVisible();
    const tasks = document.querySelector("[data-composer-tasks]");
    expect(tasks).not.toBeNull();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    expect(context).not.toBeNull();
    context!.fillStyle = getComputedStyle(tasks!).backgroundColor;
    context!.fillRect(0, 0, 1, 1);
    expect([...context!.getImageData(0, 0, 1, 1).data]).toEqual([17, 17, 17, 255]);
  });

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
    const chevron = document.querySelector("[data-composer-tasks] button > svg:last-child");
    expect(chevron).not.toBeNull();
    expect(getComputedStyle(chevron!).rotate).toBe("none");
    await expect
      .element(page.getByText("Select highest-impact lowest-effort fix and implement"))
      .not.toBeInTheDocument();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    expect(getComputedStyle(chevron!).rotate).toBe("180deg");
    await expect.element(page.getByRole("list", { name: /Task list/ })).toBeVisible();
    await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Pending", { exact: true }).first()).toBeVisible();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("list", { name: /Task list/ })).not.toBeInTheDocument();
  });
});
