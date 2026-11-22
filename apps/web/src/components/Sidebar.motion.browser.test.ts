import { describe, expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { createSidebarListMotion, sidebarListScrolled } from "./Sidebar.motion";

describe("sidebar list motion", () => {
  it("slides rows above a removal at the bottom instead of jumping with the scroll clamp", async () => {
    await using screen = await render(null);
    const viewport = document.createElement("div");
    viewport.dataset.slot = "scroll-area-viewport";
    viewport.style.cssText = "height: 200px; overflow-y: auto; overflow-anchor: none";
    const list = document.createElement("ul");
    list.style.cssText = "position: relative; margin: 0; padding: 0; list-style: none";
    const rows = Array.from({ length: 10 }, () => {
      const row = document.createElement("li");
      row.style.height = "64px";
      list.append(row);
      return row;
    });
    viewport.append(list);
    screen.container.append(viewport);
    const motion = createSidebarListMotion(list);
    using _motion = { [Symbol.dispose]: () => motion.dispose() };
    motion.update(false);
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    const above = rows[7]!;
    const before = above.getBoundingClientRect().top;

    rows[8]!.remove();
    // The clamp's scroll event can land while the update waits for its frame.
    motion.scheduleUpdate(true);
    viewport.dispatchEvent(new Event("scroll"));
    motion.update(true);
    for (const animation of above.getAnimations()) animation.pause();

    expect(above.getBoundingClientRect().top).toBe(before);
  });

  it("lands rows in place when the app scrolls right after a clamped update", async () => {
    await using screen = await render(null);
    const viewport = document.createElement("div");
    viewport.dataset.slot = "scroll-area-viewport";
    viewport.style.cssText = "height: 200px; overflow-y: auto; overflow-anchor: none";
    const list = document.createElement("ul");
    list.style.cssText = "position: relative; margin: 0; padding: 0; list-style: none";
    const rows = Array.from({ length: 10 }, () => {
      const row = document.createElement("li");
      row.style.height = "64px";
      list.append(row);
      return row;
    });
    viewport.append(list);
    screen.container.append(viewport);
    const motion = createSidebarListMotion(list);
    using _motion = { [Symbol.dispose]: () => motion.dispose() };
    motion.update(false);
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));

    rows[8]!.remove();
    motion.update(true);
    viewport.scrollTop = 0;
    sidebarListScrolled(list);
    for (const animation of rows[0]!.getAnimations()) animation.pause();

    expect(rows[0]!.getBoundingClientRect().top).toBe(viewport.getBoundingClientRect().top);
  });
});
