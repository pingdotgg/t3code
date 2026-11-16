import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { FileHtmlPreview } from "./FileHtmlPreview";
import "~/index.css";
it("zooms the sandboxed HTML page and resets to 100 percent", async () => {
  const url = URL.createObjectURL(
    new Blob(
      [
        '<h1>HTML page</h1><script>addEventListener("load",()=>parent.postMessage("html-fixture-ready","*")); addEventListener("message",e=>{if(e.data?.type==="fixture-pinch") dispatchEvent(new WheelEvent("wheel",{ctrlKey:true,deltaY:e.data.delta,cancelable:true}))})</script>',
      ],
      { type: "text/html" },
    ),
  );
  try {
    let notifyReady = () => {};
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const loaded = (event: MessageEvent) => {
      if (event.data === "html-fixture-ready") notifyReady();
    };
    window.addEventListener("message", loaded);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", loaded) };
    await using screen = await render(
      <div className="flex h-[400px] w-[500px]">
        <FileHtmlPreview src={url} title="HTML zoom" />
      </div>,
    );
    await ready;
    const width = screen.container.getBoundingClientRect().width;
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.element(screen.getByText("125%")).toBeVisible();
    expect(screen.container.getBoundingClientRect().width).toBe(width);
    expect(screen.container.querySelector("iframe")!.sandbox.contains("allow-same-origin")).toBe(
      false,
    );
    await screen.getByRole("button", { name: "Reset zoom to 100%" }).click();
    await expect.element(screen.getByText("100%")).toBeVisible();
    await screen.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.element(screen.getByText("75%")).toBeVisible();
    const frame = screen.container.querySelector("iframe")!;
    frame.contentWindow!.postMessage({ type: "fixture-pinch", delta: -90 }, "*");
    await expect.element(screen.getByText("100%")).toBeVisible();
    frame.contentWindow!.postMessage({ type: "fixture-pinch", delta: -22.314355 }, "*");
    await expect.element(screen.getByText("125%")).toBeVisible();
  } finally {
    URL.revokeObjectURL(url);
  }
});
