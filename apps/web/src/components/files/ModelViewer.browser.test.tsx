import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ComposerFilePreviewDialog } from "../chat/ComposerAttachmentStrip";
import ModelViewer from "./ModelViewer";
import { useModelPreviewStore } from "./modelAnnotations";
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

it("applies a saved camera to the replacement scene when its request target changes", async () => {
  const previous = useModelPreviewStore.getState();
  using _restoreStore = {
    [Symbol.dispose]: () => useModelPreviewStore.setState(previous, true),
  };
  const src = URL.createObjectURL(new Blob([triangle]));
  using _revokeSource = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const view = (key: string) => (
    <div className="flex h-96 w-80">
      <ModelViewer
        src={src}
        name="panel.stl"
        format="stl"
        memoryKey="saved-camera-replacement"
        viewRequestKey={key}
        onRefreshUrl={undefined}
        linkPath="panel.stl"
        composerDraftTarget={undefined}
        toolbarSlots={{ stats: null, actions: null }}
      />
    </div>
  );
  await using screen = await render(view("first-camera-target"));
  await expect.element(screen.getByRole("button", { name: "Fit" })).toBeEnabled();
  useModelPreviewStore.getState().requestView("second-camera-target", {
    position: [100, 0, 0],
    target: [0, 0, 0],
  });
  await screen.rerender(view("second-camera-target"));
  await expect.element(screen.getByText("az 90° el 0°")).toBeVisible();
});

it("keeps earlier screenshot labels after deleting a stale pin and adding a live pin", async () => {
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
  const pick = (x: number) =>
    userEvent.click(viewer, {
      position: { x: viewer.element().clientWidth / 2 + x, y: viewer.element().clientHeight / 2 },
    });
  const pin = page.getByRole("button", { name: "Pin", exact: true });
  await expect.element(page.getByRole("button", { name: "Top" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "Top" }));
  await userEvent.click(page.getByRole("button", { name: "Annotate" }));
  await pick(12);
  const note = page.getByRole("textbox", { name: "Note", exact: true });
  await userEvent.fill(note, "Round this edge");
  note
    .element()
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
  await expect.element(note).toHaveValue("Round this edge");
  await userEvent.click(pin);
  await expect.element(page.getByRole("button", { name: "Note 1: Round this edge" })).toBeVisible();
  await pick(40);
  await userEvent.fill(note, "Keep this face");
  await userEvent.click(pin);
  await expect.element(page.getByRole("button", { name: "Note 2: Keep this face" })).toBeVisible();
  const revised = new File([triangle.replace("vertex 20 20 0", "vertex -20 20 0")], name, {
    type: file.type,
  });
  await screen.rerender(dialog("local-panel", revised));
  await expect.element(page.getByText(/The model changed after 2 notes/)).toBeVisible();
  await userEvent.click(
    page
      .getByRole("listitem")
      .filter({ hasText: "Round this edge" })
      .getByRole("button", { name: "Remove" }),
  );
  await expect.element(page.getByText(/The model changed after 1 note/)).toBeVisible();
  await expect.element(page.getByText("2. Keep this face")).toBeVisible();
  await expect.element(page.getByText("Click the model to pin a note")).toBeVisible();
  await pick(-16);
  await userEvent.fill(note, "Keep this new pin");
  await userEvent.click(pin);
  const livePin = page.getByRole("button", { name: "Note 3: Keep this new pin" });
  await expect.element(livePin).toBeVisible();
  await expect.element(page.getByText("2. Keep this face")).toBeVisible();
  const send = page.getByRole("button", { name: "Send 2 to chat" });
  await userEvent.click(send);
  await expect.element(send).not.toBeInTheDocument();
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft?.previewAnnotations).toEqual([
    expect.objectContaining({
      pageUrl: "attachment:panel.stl",
      comment: expect.stringMatching(
        /2\. Keep this face \(placed on an earlier version[^\n]*\n3\. Keep this new pin \(surface point[^\n]*\nThe screenshot shows the model before it last changed\./,
      ),
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
  const replacement = Promise.withResolvers<Response>();
  const fetchModel = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(triangle))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementationOnce(() => replacement.promise);
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

  await userEvent.click(screen.getByRole("button", { name: "Front" }));
  await expect.element(screen.getByText("az 0° el 0°")).toBeVisible();
  const oldCanvas = screen.getByRole("application").element().querySelector("canvas");
  expect(oldCanvas?.isConnected).toBe(true);
  await screen.rerender(view("/test-model/unavailable.stl"));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.rerender(view("/test-model/repaired.stl"));
  await expect.element(screen.getByRole("button", { name: "Fit" })).toBeEnabled();
  await expect.element(screen.getByText("az 0° el 0°")).toBeVisible();
  replacement.resolve(new Response(triangle.replace("vertex 20 20 0", "vertex 40 20 0")));
  await vi.waitFor(() => expect(oldCanvas?.isConnected).toBe(false));
  await expect.element(screen.getByText("az 0° el 0°")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Fit" })).toBeEnabled();
  expect(fetchModel.mock.calls.map(([url]) => url)).toEqual([
    "/test-model/initial.stl",
    "/test-model/initial.stl",
    "/test-model/unavailable.stl",
    "/test-model/repaired.stl",
  ]);
});
