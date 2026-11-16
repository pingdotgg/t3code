import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import docx from "./test-fixtures/toolbar.docx?url";
import pptx from "./test-fixtures/toolbar.pptx?url";
import "~/index.css";
it.each([
  ["docx", docx],
  ["pptx", pptx],
  ["html", "data:text/html,<h1>Preview</h1>"],
] as const)("renders one toolbar for embedded %s with download retained", async (ext, url) => {
  using cleanup = new DisposableStack();
  if (ext === "pptx") {
    // Exercise the real presentation component and shared chrome. Vitest's dynamic-import
    // wrapper is unavailable inside the slide engine's worker, so stand in only for its RPC.
    const workerUrl = URL.createObjectURL(
      new Blob(
        [
          `
      onmessage = ({data}) => {
        if (!data.method) return;
        const value = data.method === 'open'
          ? Array.from({length: 3}, () => ({width: 960, height: 540, hidden: false}))
          : {kind: 'cancelled'};
        postMessage({id: data.id, ok: true, value, transferred: []});
      };
    `,
        ],
        { type: "text/javascript" },
      ),
    );
    const NativeWorker = globalThis.Worker;
    const spy = vi.spyOn(globalThis, "Worker").mockImplementation(function (source, options) {
      return new NativeWorker(
        String(source).includes("presentation.worker.ts") ? workerUrl : source,
        options,
      );
    });
    cleanup.defer(() => {
      spy.mockRestore();
      URL.revokeObjectURL(workerUrl);
    });
  }
  const file = await (await fetch(url)).blob();
  const onClose = vi.fn();
  await using screen = await render(
    <div className="flex h-[500px] w-[700px]">
      <AttachmentFilePreview
        embedded
        name={`toolbar.${ext}`}
        origin="File"
        mimeType="application/octet-stream"
        sizeBytes={file.size}
        file={file}
        onClose={onClose}
      />
    </div>,
  );
  await expect.element(screen.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll('[aria-label="Zoom in"]')).toHaveLength(1);
  expect(screen.container.querySelectorAll("[data-surface-subheader]")).toHaveLength(0);
  expect(screen.container.textContent).not.toContain("Fit to width");
  await expect
    .element(screen.getByRole("button", { name: "Save file", exact: true }))
    .toBeVisible();
  if (ext === "html") {
    await screen.getByRole("button", { name: "Show HTML source", exact: true }).click();
    await screen.getByRole("button", { name: "Show rendered page", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Zoom in", exact: true }))
      .toBeVisible();
    expect(screen.container.querySelectorAll("[data-surface-subheader]")).toHaveLength(0);
  }
  await screen.getByRole("button", { name: "Close", exact: true }).click();
  expect(onClose).toHaveBeenCalledOnce();
});
