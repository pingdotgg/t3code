import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { MiddleTruncate } from "./middle-truncate";

import "~/index.css";

const narrow = (value: string) => (
  <div style={{ width: 80 }}>
    <MiddleTruncate value={value} className="w-full" />
  </div>
);

describe("MiddleTruncate", () => {
  it("does not clip a short value that replaces a truncated one", async () => {
    await using screen = await render(narrow("t3/investigate-release-build-times"));
    const label = () => screen.container.querySelector("[title] > span");
    await expect.poll(() => label()?.hasAttribute("data-overflow")).toBe(true);

    await screen.rerender(narrow("main"));

    expect(label()).toHaveTextContent("main");
    expect(label()).not.toHaveAttribute("data-overflow");
    expect(label()).toHaveStyle({ clipPath: "none" });
  });

  it("keeps the space where the head meets the tail", async () => {
    await using screen = await render(
      <div>
        <MiddleTruncate value="Fix the sidebar" tail={7} data-testid="split" />
        <span data-testid="whole" className="whitespace-nowrap">
          Fix the sidebar
        </span>
      </div>,
    );
    const width = (id: string) => screen.getByTestId(id).element().getBoundingClientRect().width;

    expect(width("split")).toBeCloseTo(width("whole"), 0);
  });
});
