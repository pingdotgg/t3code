import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Dialog, DialogPopup } from "./dialog";

it("disables backdrop filtering without changing dimming and restores the 4px blur", async () => {
  const root = document.documentElement;
  const originalStyle = root.getAttribute("style");
  const originalClass = root.getAttribute("class");
  const motion = document.createElement("style");
  motion.textContent = '[data-slot="dialog-backdrop"] { transition: none !important; }';
  document.head.append(motion);
  using _appearance = {
    [Symbol.dispose]() {
      motion.remove();
      if (originalStyle === null) root.removeAttribute("style");
      else root.setAttribute("style", originalStyle);
      if (originalClass === null) root.removeAttribute("class");
      else root.setAttribute("class", originalClass);
    },
  };
  root.style.removeProperty("--dialog-backdrop-filter");
  await using _screen = await render(
    <Dialog open>
      <DialogPopup aria-label="Example dialog">Dialog content</DialogPopup>
    </Dialog>,
  );
  await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
  const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
  if (!(backdrop instanceof HTMLElement)) throw new Error("Missing dialog backdrop");

  for (const appearance of ["light", "dark"]) {
    root.classList.toggle("dark", appearance === "dark");
    const tint = getComputedStyle(backdrop).backgroundColor;
    expect(getComputedStyle(backdrop).backdropFilter).toBe("blur(4px)");

    root.style.setProperty("--dialog-backdrop-filter", "none");
    await vi.waitFor(() => expect(getComputedStyle(backdrop).backdropFilter).toBe("none"));
    expect(getComputedStyle(backdrop).backgroundColor).toBe(tint);

    root.style.removeProperty("--dialog-backdrop-filter");
    await vi.waitFor(() => expect(getComputedStyle(backdrop).backdropFilter).toBe("blur(4px)"));
    expect(getComputedStyle(backdrop).backgroundColor).toBe(tint);
  }
});
