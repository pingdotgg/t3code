import type { CSSProperties } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

function Panel({
  storageKey = "reset-panel-a",
  defaultWidth = 400,
  maxWidth = 800,
}: {
  storageKey?: string;
  defaultWidth?: number;
  maxWidth?: number;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth,
    minWidth: 200,
    maxWidth,
    edge: "left",
  });
  return (
    <aside
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
        } as CSSProperties
      }
    >
      <output>{width}</output>
      <div role="separator" style={{ width: 8, height: 100 }} {...handlers} />
    </aside>
  );
}

it("resets only the current panel to its current clamped default and leaves remounts adaptive", async () => {
  localStorage.setItem("reset-panel-a", "450");
  localStorage.setItem("reset-panel-b", "300");
  await using screen = await render(<Panel />);
  await screen.rerender(<Panel storageKey="reset-panel-b" defaultWidth={600} maxWidth={500} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("300");

  await userEvent.dblClick(screen.getByRole("separator"));
  await expect.element(screen.getByRole("status")).toHaveTextContent("500");
  expect(localStorage.getItem("reset-panel-b")).toBeNull();
  expect(localStorage.getItem("reset-panel-a")).toBe("450");

  await screen.rerender(<Panel key="remount" storageKey="reset-panel-b" defaultWidth={700} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("700");
});

it("resets the visible width even when removing the saved width fails", async () => {
  localStorage.setItem("reset-panel-a", "500");
  await using screen = await render(<Panel />);
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  using _remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });

  await userEvent.dblClick(screen.getByRole("separator"));
  await expect.element(screen.getByRole("status")).toHaveTextContent("400");
  expect(localStorage.getItem("reset-panel-a")).toBe("500");
});
