import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ComposerFilePreviewDialog } from "../chat/ComposerAttachmentStrip";
import ModelViewer from "./ModelViewer";
import "~/index.css";

const triangle = [
  "solid panel",
  "facet normal 0 0 1",
  "outer loop",
  "vertex -20 -20 0",
  "vertex 20 -20 0",
  "vertex 20 20 0",
  "endloop",
  "endfacet",
  "endsolid panel",
].join("\n");

it("keeps a draft attachment pin isolated and sends its earlier screenshot after an edit", async () => {
  const target = {
    environmentId: EnvironmentId.make("model-attachment-test"),
    threadId: ThreadId.make("model-attachment-test"),
  };
  const name = "panel.stl";
  const file = new File([triangle], name, { type: "model/stl" });
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(360, 720);
  await using _restoreViewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const dialog = (id: string, model: File) => (
    <ComposerFilePreviewDialog
      file={{ id, name, file: model, mimeType: model.type, sizeBytes: model.size, type: "file" }}
      composerDraftTarget={target}
      onRemove={() => undefined}
      onPreviewFileIdChange={() => undefined}
    />
  );
  await using screen = await render(dialog("local-panel", file));
  const viewer = page.getByRole("application", { name: "3D view of panel.stl" });
  await expect.element(page.getByRole("button", { name: "Top" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "Top" }));
  await userEvent.click(page.getByRole("button", { name: "Annotate" }));
  await userEvent.click(viewer, {
    position: { x: viewer.element().clientWidth / 2 + 12, y: viewer.element().clientHeight / 2 },
  });
  const note = page.getByRole("textbox", { name: "Note", exact: true });
  await userEvent.fill(note, "Round this edge");
  note
    .element()
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
  await expect.element(note).toHaveValue("Round this edge");
  await userEvent.click(page.getByRole("button", { name: "Pin", exact: true }));
  await expect.element(page.getByRole("button", { name: "Note 1: Round this edge" })).toBeVisible();
  await screen.rerender(dialog("other-panel", file));
  await expect.element(page.getByRole("button", { name: "Top" })).toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Note 1: Round this edge" }))
    .not.toBeInTheDocument();

  const revised = new File([triangle.replace("vertex 20 20 0", "vertex -20 20 0")], name, {
    type: file.type,
  });
  await screen.rerender(dialog("local-panel", revised));
  await expect.element(page.getByText(/The model changed after 1 note/)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Annotate" }));
  await userEvent.click(page.getByRole("button", { name: "Send 1 to chat" }));
  await expect
    .element(page.getByRole("button", { name: "Send 1 to chat" }))
    .not.toBeInTheDocument();
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.previewAnnotations).toEqual([
    expect.objectContaining({
      pageUrl: "attachment:panel.stl",
      comment: expect.stringContaining("The screenshot shows the model before it last changed."),
    }),
  ]);
  expect(draft?.images).toEqual([
    expect.objectContaining({ id: draft?.previewAnnotations[0]?.id, mimeType: "image/png" }),
  ]);
  const screenshot = draft?.images[0]?.file;
  if (!screenshot) throw new Error("The annotation has no screenshot");
  const bitmap = await createImageBitmap(screenshot);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The screenshot could not be decoded");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let pinPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 59 && data[i + 1] === 110 && data[i + 2] === 245) pinPixels++;
    }
    // The saved view should show a small pin. A detached canvas used to make it fill the image.
    expect(pinPixels).toBeGreaterThan(0);
    expect(pinPixels).toBeLessThan(bitmap.width * bitmap.height * 0.02);
  } finally {
    bitmap.close();
  }
});

it("retries a failed model load and recovers when its source changes", async () => {
  const existingFetch = globalThis.fetch;
  const fetchModel = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(triangle))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(triangle));
  using _fetch = stubGlobal("fetch", (arg: RequestInfo | URL, init?: RequestInit) =>
    typeof arg === "string" && arg.startsWith("/test-model/")
      ? fetchModel(arg, init)
      : existingFetch(arg, init),
  );
  const view = (src: string) => (
    <div className="flex h-96 w-80">
      <ModelViewer
        src={src}
        name="panel.stl"
        format="stl"
        memoryKey="retry-example"
        viewRequestKey={null}
        onRefreshUrl={undefined}
        linkPath={null}
        composerDraftTarget={undefined}
        toolbarSlots={{ stats: null, actions: null }}
      />
    </div>
  );
  await using screen = await render(view("/test-model/initial.stl"));
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await expect.element(screen.getByRole("button", { name: "Fit" })).toBeEnabled();
  expect(fetchModel.mock.calls[1]?.[1]?.cache).toBe("reload");

  await screen.rerender(view("/test-model/unavailable.stl"));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.rerender(view("/test-model/repaired.stl"));
  await expect.element(screen.getByRole("button", { name: "Fit" })).toBeEnabled();
  expect(fetchModel.mock.calls.map(([url]) => url)).toEqual([
    "/test-model/initial.stl",
    "/test-model/initial.stl",
    "/test-model/unavailable.stl",
    "/test-model/repaired.stl",
  ]);
});
