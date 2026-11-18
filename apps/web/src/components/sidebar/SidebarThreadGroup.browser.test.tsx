import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarThreadGroup, SidebarThreadGroupOverflowRow } from "./SidebarThreadGroup";

const rows = ["one", "two", "three"].map((name) => (
  <div key={name} className="h-8">
    <span data-thread-group-anchor>{name}</span>
  </div>
));

it("draws one branch per anchor", async () => {
  await using screen = await render(
    <SidebarThreadGroup expanded trunkX={10} branchEndX={30} trunkTopOffset={12}>
      {rows}
    </SidebarThreadGroup>,
  );
  await expect
    .poll(() => screen.container.querySelector("svg path")?.getAttribute("d")?.match(/H/g)?.length)
    .toBe(3);
  expect(screen.container.querySelectorAll("svg")).toHaveLength(1);
});

it("collapsed group hides workers", async () => {
  await using screen = await render(
    <SidebarThreadGroup expanded={false} trunkX={10} branchEndX={30} trunkTopOffset={12}>
      {rows}
    </SidebarThreadGroup>,
  );
  await expect.element(screen.getByText("one")).not.toBeInTheDocument();
});

it("overflow row shows its count and expands on click", async () => {
  const onExpand = vi.fn();
  await using screen = await render(
    <SidebarThreadGroupOverflowRow kind="settled" count={4} onExpand={onExpand} />,
  );
  await screen.getByText("+4 settled").click();
  expect(onExpand).toHaveBeenCalledTimes(1);
});

it("expanded overflow row offers Show less instead of the count", async () => {
  const onExpand = vi.fn();
  const onCollapse = vi.fn();
  await using screen = await render(
    <SidebarThreadGroupOverflowRow
      kind="settled"
      count={4}
      onExpand={onExpand}
      expanded
      onCollapse={onCollapse}
    />,
  );
  await expect.element(screen.getByText("+4 settled")).not.toBeInTheDocument();
  expect(screen.container.querySelector("[data-thread-group-anchor]")).toBeNull();
  await screen.getByText("Show less").click();
  expect(onCollapse).toHaveBeenCalledTimes(1);
  expect(onExpand).not.toHaveBeenCalled();
});
