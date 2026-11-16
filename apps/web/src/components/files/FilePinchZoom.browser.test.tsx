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
