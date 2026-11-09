import { expect, it, vi } from "vite-plus/test";
import { createSidebarListMotion } from "./Sidebar.motion";

function mountList(names: readonly string[]) {
  const list = document.createElement("ul");
  list.style.position = "relative";
  const rows = new Map<string, HTMLLIElement>();
  for (const name of names) {
    const row = document.createElement("li");
    row.style.height = "20px";
    row.textContent = name;
    rows.set(name, row);
    list.append(row);
  }
  document.body.append(list);
  const motion = createSidebarListMotion(list);
  motion.update(false);
  return {
    list,
    rows,
    motion,
    [Symbol.dispose]: () => {
      motion.dispose();
      list.remove();
    },
  };
}

it("does not queue row motion while the document is hidden", () => {
  using fixture = mountList(["a", "b"]);
  using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  fixture.list.prepend(fixture.rows.get("b")!);
  fixture.motion.update(true);
  expect(fixture.list.getAnimations({ subtree: true })).toHaveLength(0);

  visibility.mockReturnValue("visible");
  fixture.list.prepend(fixture.rows.get("a")!);
  fixture.motion.update(true);
  expect(fixture.list.getAnimations({ subtree: true }).length).toBeGreaterThan(0);
});

it("drops in-flight row motion when the document becomes hidden", () => {
  using fixture = mountList(["a", "b"]);
  using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fixture.list.prepend(fixture.rows.get("b")!);
  fixture.motion.update(true);
  expect(fixture.list.getAnimations({ subtree: true }).length).toBeGreaterThan(0);

  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(fixture.list.getAnimations({ subtree: true })).toHaveLength(0);
});

it("does not slide rows from positions measured before a window resize", () => {
  using fixture = mountList(["a", "b"]);
  using _visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fixture.rows.get("a")!.style.height = "60px";
  window.dispatchEvent(new Event("resize"));
  fixture.motion.update(true);
  expect(fixture.list.getAnimations({ subtree: true })).toHaveLength(0);
});

it("does not replay a drag release that ended while the document was hidden", () => {
  using fixture = mountList(["a", "b"]);
  using visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  fixture.motion.release();
  visibility.mockReturnValue("visible");
  fixture.list.prepend(fixture.rows.get("b")!);
  fixture.motion.update(false);
  expect(fixture.list.getAnimations({ subtree: true })).toHaveLength(0);
});
