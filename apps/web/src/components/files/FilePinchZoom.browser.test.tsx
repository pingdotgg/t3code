import VirtualTablePreview from "./VirtualTablePreview";
import { ZoomableMediaViewport } from "./ZoomableMediaViewport";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import PreviewImageContent from "./PreviewImageContent";
import { OfficePages } from "./office/OfficePages";
import DocumentPages from "./DocumentPages";
import "~/index.css";

it.each(["image", "office"] as const)("pinches %s content locally", async (kind) => {
  const image = document.createElement("canvas");
  image.width = 1000;
  image.height = 1600;
  await using screen = await render(
    <div className="flex h-[400px] w-[500px] flex-col">
      {kind === "image" ? (
        <PreviewImageContent src={image.toDataURL()} name="test.png" />
      ) : (
        <OfficePages
          pages={[{ width: 600, height: 1600 }]}
          paint={async () => {}}
          label="Document page"
          onError={() => {}}
        />
      )}
    </div>,
  );
  const target = () =>
    kind === "image"
      ? screen.getByRole("img").element()
      : screen.getByRole("group", { name: "Document page 1" }).element();
  await vi.waitFor(() => expect(target().getBoundingClientRect().width).toBeGreaterThan(0));
  const width = target().getBoundingClientRect().width;
  const locator =
    kind === "image"
      ? screen.getByRole("img")
      : screen.getByRole("group", { name: "Document page 1" });
  await userEvent.keyboard("{Control>}");
  await userEvent.wheel(locator, { delta: { y: -40 } });
  await userEvent.keyboard("{/Control}");
  await vi.waitFor(() => expect(target().getBoundingClientRect().width).toBeGreaterThan(width));
  const enlarged = target().getBoundingClientRect().width;
  await userEvent.keyboard("{Control>}");
  await userEvent.wheel(locator, { delta: { y: 20 } });
  await userEvent.keyboard("{/Control}");
  await vi.waitFor(() => expect(target().getBoundingClientRect().width).toBeLessThan(enlarged));
  expect(screen.container.getBoundingClientRect().width).toBeGreaterThan(0);
});

it("consumes pinch inside the document frame and updates reading size", async () => {
  await using screen = await render(
    <DocumentPages name="Reading document" html="<p>Document text</p>" />,
  );
  const frame = screen.container.querySelector("iframe")!;
  await vi.waitFor(() =>
    expect(frame.contentDocument?.body.textContent).toContain("Document text"),
  );
  const event = new WheelEvent("wheel", {
    ctrlKey: true,
    deltaY: -20,
    cancelable: true,
  });
  frame.contentWindow!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() =>
    expect(
      Number(frame.contentDocument!.documentElement.style.getPropertyValue("--reading-zoom")),
    ).toBeGreaterThan(1),
  );
});

it("zooms video from a fitted 100 percent to 500 percent and resets", async () => {
  await using screen = await render(
    <div className="flex h-[400px] w-[500px]">
      <ZoomableMediaViewport>
        <video aria-label="Zoom video" style={{ width: 400, height: 300 }} />
      </ZoomableMediaViewport>
    </div>,
  );
  const locator = screen.getByLabelText("Zoom video");
  const video = locator.element();
  const width = video.getBoundingClientRect().width;
  expect(screen.container.querySelector('input[type="range"]')).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Zoom out", exact: true }))
    .toBeDisabled();
  await userEvent.keyboard("{Control>}");
  await userEvent.wheel(locator, { delta: { y: 30 } });
  await userEvent.keyboard("{/Control}");
  expect(video.getBoundingClientRect().width).toBe(width);
  await userEvent.keyboard("{Control>}");
  await userEvent.wheel(locator, { delta: { y: -1000 } });
  await userEvent.keyboard("{/Control}");
  await vi.waitFor(() => expect(video.getBoundingClientRect().width).toBe(width * 5));
  await screen.getByRole("button", { name: "Reset zoom to 100%", exact: true }).click();
  await vi.waitFor(() => expect(video.getBoundingClientRect().width).toBe(width));
});

it("keeps virtual tables filling their viewport when zoomed out", async () => {
  const rows = Array.from({ length: 250 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => `${row}:${col}`),
  );
  await using screen = await render(
    <div className="flex h-[400px] w-[600px]">
      <VirtualTablePreview
        name="Grid"
        count={rows.length}
        columns={8}
        header={rows[0]}
        getRows={() => rows}
      />
    </div>,
  );
  const viewport = screen.getByRole("region", { name: "Table preview" }).element();
  for (let step = 0; step < 3; step++)
    await screen.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.element(screen.getByText("25%", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    const area = viewport.getBoundingClientRect();
    const grid = viewport.querySelector("[data-zoom-scroll]")!.getBoundingClientRect();
    expect(Math.abs(grid.width - area.width)).toBeLessThan(2);
    expect(Math.abs(grid.height - area.height)).toBeLessThan(2);
    expect(Math.abs(grid.left - area.left)).toBeLessThan(2);
    expect(Math.abs(grid.top - area.top)).toBeLessThan(2);
  });
});
