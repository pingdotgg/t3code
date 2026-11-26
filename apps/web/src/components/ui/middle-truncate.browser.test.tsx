import { describe, expect, it, vi } from "vite-plus/test";

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
    const label = () => screen.container.querySelector("[title] > span > span");
    await expect.poll(() => label()?.hasAttribute("data-overflow")).toBe(true);

    await screen.rerender(narrow("main"));

    expect(label()).toHaveTextContent("main");
    expect(label()).not.toHaveAttribute("data-overflow");
    expect(label()).toHaveStyle({ clipPath: "none" });
  });

  it("fits every head mounted in the same commit", async () => {
    const values = ["t3/investigate-release-build-times", "t3/remove-stale-worktree-branches"];
    await using screen = await render(
      <>
        {values.map((value) => (
          <div key={value}>{narrow(value)}</div>
        ))}
      </>,
    );
    const heads = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[title] > span > span:first-child"),
    ];

    await vi.waitFor(() =>
      expect(heads().filter((head) => head.hasAttribute("data-overflow"))).toHaveLength(2),
    );
  });

  it.each([
    ["Fix the sidebar", 7],
    ["report\u2003\u2003draft.txt", 9],
  ])("renders %j split as wide as whole", async (value, tail) => {
    await using screen = await render(
      <div>
        <MiddleTruncate value={value} tail={tail} data-testid="split" />
        <span data-testid="whole" className="whitespace-nowrap">
          {value}
        </span>
      </div>,
    );
    const width = (id: string) => screen.getByTestId(id).element().getBoundingClientRect().width;

    expect(width("split")).toBeCloseTo(width("whole"), 0);
  });

  it.each([
    ["t3/investigate-release-build-times", "ltr"],
    ["ענף/תיקון-בניית-השחרור-האיטית", "rtl"],
  ] as const)("cuts %j at the head's end inside an RTL row", async (value, direction) => {
    await using screen = await render(<div dir="rtl">{narrow(value)}</div>);
    const [head, tail] = [
      ...screen.container.querySelectorAll<HTMLElement>("[title] > span > span"),
    ];
    await expect.poll(() => head?.hasAttribute("data-overflow")).toBe(true);
    const headBox = head!.getBoundingClientRect();
    const tailBox = tail!.getBoundingClientRect();

    if (direction === "ltr") expect(headBox.left).toBeLessThan(tailBox.left);
    else expect(headBox.left).toBeGreaterThan(tailBox.left);
  });

  it("keeps the raw value's tail when collapsing its spaces", async () => {
    await using screen = await render(<MiddleTruncate value={"longprefix a  b.txt"} />);

    expect(screen.container.querySelector("[title] > span > span:last-child")?.textContent).toBe(
      "x a b.txt",
    );
  });
});
