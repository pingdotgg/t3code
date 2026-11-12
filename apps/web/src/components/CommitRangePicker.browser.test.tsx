import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommitRangePicker } from "./CommitRangePicker";

function CommitRange() {
  const commits = Array.from({ length: 7 }, (_, index) => ({
    sha: String(index + 1).repeat(40),
    shortSha: String(index + 1).repeat(7),
    subject: `Change ${index + 1}`,
    body: "",
    authoredAt: "2026-11-11T10:00:00Z",
    files: ["file.ts"],
  }));
  const [range, setRange] = useState({ start: 0, end: commits.length - 1 });
  return (
    <CommitRangePicker
      commits={commits}
      startIndex={range.start}
      endIndex={range.end}
      onReset={() => setRange({ start: 0, end: commits.length - 1 })}
      onRangeChange={(start, end) => setRange({ start, end })}
    />
  );
}

it("selects an inclusive middle range, keeps crossing boundaries valid, and resets to all commits", async () => {
  await using screen = await render(<CommitRange />);
  await expect.element(screen.getByText("7 commits selected")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Start at 2222222: Change 2" }));
  await userEvent.click(screen.getByRole("button", { name: "End at 6666666: Change 6" }));
  await expect.element(screen.getByText("5 commits selected")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Start at 2222222: Change 2" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "Start at 7777777: Change 7" }));
  await expect.element(screen.getByText("1 commit selected")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "End at 7777777: Change 7" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "End at 1111111: Change 1" }));
  await expect.element(screen.getByText("1 commit selected")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Start at 1111111: Change 1" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "All commits" }));
  await expect.element(screen.getByText("7 commits selected")).toBeVisible();
});
