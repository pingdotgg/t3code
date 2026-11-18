import { useState } from "react";
import type { SnapShotSource } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import {
  ExpandedImageDialog,
  ExpandedImageDialogHost,
  openExpandedImagePreview,
} from "./ExpandedImageDialog";
import type { ExpandedImageItem } from "./ExpandedImagePreview";
import type { ImageEditorResult } from "../image-editor/ImageEditor";
import { createImageEditorDocument } from "../image-editor/imageEditorDocument";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { toastManager } from "../ui/toast";
import { retainThreadOverlaysForThread } from "./threadOverlayRetention";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const snapShotSource: SnapShotSource = {
  kind: "snap-shot",
  capturedAt: "2026-01-01T00:00:00.000Z",
  appName: "Finder",
  windowTitle: "Downloads",
};

const D2_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1174 920"><rect width="1174" height="920"/></svg>';

function ImagePreviewOpener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open preview
      </button>
      {open && (
        <ExpandedImageDialog
          preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DockedImagePreview({
  docked = true,
  src = PIXEL,
  edit = false,
  actionsSource,
  onClose,
}: {
  docked?: boolean;
  src?: string | null;
  edit?: boolean;
  actionsSource?: ExpandedImageItem["actionsSource"];
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex h-[700px] w-full">
      <div aria-label="App sidebar" className="w-[280px] shrink-0" />
      <div className="@container/image-workspace relative flex min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          <div role="textbox" aria-label="Thread message" contentEditable className="min-h-20" />
        </div>
        {open && (
          <ExpandedImageDialog
            dockEditor={docked}
            preview={{
              images: [{ src, name: "shot.png", ...(actionsSource ? { actionsSource } : {}) }],
              index: 0,
              edit,
            }}
            onClose={() => {
              setOpen(false);
              onClose?.();
            }}
          />
        )}
      </div>
    </div>
  );
}

describe("ExpandedImageDialog", () => {
  it("keeps a modal annotation after scrolling its pin away and pressing Escape", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(1280, 700);
    const src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>')}`;
    const onClose = vi.fn();
    await using screen = await render(
      <DockedImagePreview docked={false} src={src} edit onClose={onClose} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Comment pin", exact: true }))
      .toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom in", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
    const canvas = screen.getByRole("application", { name: "Editable annotations" });
    await userEvent.click(canvas, { position: { x: 100, y: 80 } });
    const comment = page.getByRole("textbox", { name: "Annotation comment", exact: true });
    await expect.element(comment).toHaveFocus();
    await userEvent.fill(comment, "Keep this annotation after scrolling.");
    const scroller = screen.getByRole("region", { name: "Image editing canvas" }).element();
    const positioner = comment.element().closest('[data-slot="popover-positioner"]')!;
    await act(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    await vi.waitFor(() => expect(positioner.hasAttribute("data-anchor-hidden")).toBe(true));
    await expect.element(comment).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(comment).not.toBeInTheDocument();
    await expect.element(canvas).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Comment", exact: true }))
      .toHaveValue("Keep this annotation after scrolling.");
    expect(onClose).not.toHaveBeenCalled();
    expect(canvas.element().querySelector("circle")).not.toBeNull();
  });

  it("docks editing beside an interactive chat and closes with Escape without discarding the chat draft", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(1280, 900);
    await using screen = await render(<DockedImagePreview />);
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    const editor = screen.getByRole("complementary", { name: "Image editor", exact: true });
    await expect.element(editor).toBeVisible();
    const chat = screen.getByRole("textbox", { name: "Thread message", exact: true });
    expect(chat.element().getBoundingClientRect().width).toBeGreaterThan(350);
    expect(editor.element().getBoundingClientRect().width).toBeLessThan(600);
    await userEvent.fill(chat, "Keep this chat draft while editing");
    await expect.element(chat).toHaveTextContent("Keep this chat draft while editing");
    await expect.element(editor).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Draw", exact: true }));
    await userEvent.keyboard("{Escape}");
    await expect.element(editor).not.toBeInTheDocument();
    await expect.element(chat).toHaveTextContent("Keep this chat draft while editing");
  });

  it.each([
    { mode: "docked", docked: true },
    { mode: "modal", docked: false },
  ])("Escape cancels a live Draw gesture in the $mode editor before closing it", async (c) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(1280, 900);
    const src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>')}`;
    await using screen = await render(<DockedImagePreview docked={c.docked} src={src} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await expect.element(screen.getByRole("button", { name: "Draw", exact: true })).toBeEnabled();
    const canvasLocator = screen.getByRole("application", { name: "Editable annotations" });
    const canvas = canvasLocator.element() as SVGSVGElement;
    // Synthetic pointers have no active browser capture target.
    using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
    const pointer = async (
      type: "pointerdown" | "pointermove" | "pointerup",
      x: number,
      y: number,
    ) => {
      const bounds = canvas.getBoundingClientRect();
      await act(() => {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: bounds.left + (x / 400) * bounds.width,
            clientY: bounds.top + (y / 300) * bounds.height,
          }),
        );
      });
    };
    const annotations = () => canvas.querySelector('g[pointer-events="none"]')!.innerHTML;
    await userEvent.click(screen.getByRole("button", { name: "Draw", exact: true }));
    const original = annotations();
    const originalUndoDisabled = screen
      .getByRole("button", { name: "Undo image edit" })
      .element()
      .hasAttribute("disabled");
    await pointer("pointerdown", 20, 30);
    await pointer("pointermove", 60, 70);
    expect(annotations()).not.toBe(original);

    await userEvent.keyboard("{Escape}");
    expect(canvas.isConnected).toBe(true);
    await expect.element(canvasLocator).toBeVisible();
    await pointer("pointermove", 280, 220);
    await pointer("pointerup", 280, 220);
    expect(annotations()).toBe(original);
    expect(
      screen.getByRole("button", { name: "Undo image edit" }).element().hasAttribute("disabled"),
    ).toBe(originalUndoDisabled);
    const aspectRatio = screen.getByRole("combobox", { name: "Regenerate aspect ratio" });
    await userEvent.click(aspectRatio);
    await expect.element(page.getByRole("option", { name: "Square · 1:1" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(aspectRatio).toHaveFocus();
    await expect.element(canvasLocator).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Close image editor" }).elements()).toHaveLength(0),
    );
    if (!c.docked)
      await expect
        .element(screen.getByRole("button", { name: "Edit image", exact: true }))
        .toBeVisible();
  });

  it("loads conversation images, edits the focused image and hands its source, pixels and location comments back to chat", async () => {
    const original = { src: PIXEL, name: "first.png" };
    const originalBytes = new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>',
      ],
      { type: "image/svg+xml" },
    );
    const source = URL.createObjectURL(originalBytes);
    using _source = { [Symbol.dispose]: () => URL.revokeObjectURL(source) };
    let currentBytes = originalBytes;
    const fetchOriginal = globalThis.fetch;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        input === source ? Promise.resolve(new Response(currentBytes)) : fetchOriginal(input, init),
      );
    const focused = { src: source, name: "design.svg", source: snapShotSource };
    const onApply = vi
      .fn<(item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [original], index: 0 }}
        onLoadGallery={async () => [original, focused]}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "All images" }));
    await userEvent.click(screen.getByRole("button", { name: "Open image 2, design.svg" }));
    await expect
      .element(screen.getByRole("region", { name: "design.svg, zoomable image" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await expect
      .element(screen.getByRole("button", { name: "Comment pin", exact: true }))
      .toBeEnabled();
    currentBytes = new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/></svg>',
      ],
      { type: "image/svg+xml" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
    await userEvent.click(screen.getByRole("application", { name: "Editable annotations" }));
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Comment", exact: true }),
      "Make this cobalt blue",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const [item, result] = onApply.mock.calls[0]!;
    expect(item).toEqual(focused);
    expect(result.mode).toBe("edit");
    expect(result.document).toMatchObject({
      width: 400,
      height: 300,
      objects: [{ kind: "pin", comment: "Make this cobalt blue" }],
    });
    expect(result.originalFile.type).toBe("image/svg+xml");
    expect(await result.originalFile.text()).toContain('width="400" height="300"');
    expect(await result.originalFile.text()).toContain('fill="white"');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps gallery feedback and selection while tile Back restores the grid and gallery Back restores the original preview list", async () => {
    const first = { src: PIXEL, name: "first.png" };
    const second = { src: PIXEL, name: "second.png" };
    const other = { src: PIXEL, name: "other.png" };
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        dockEditor
        preview={{ images: [first, second], index: 1 }}
        onLoadGallery={async () => [other, first, second]}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "All images" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "other.png", exact: true }));
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Edit selected images" }),
      "Keep my feedback",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open image 2, first.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await expect.element(screen.getByRole("button", { name: "Close image editor" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Close image editor" }));
    await expect
      .element(screen.getByRole("button", { name: "Edit image", exact: true }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back, return to image gallery" }));
    await expect
      .element(screen.getByRole("checkbox", { name: "other.png", exact: true }))
      .toBeChecked();
    await expect
      .element(screen.getByRole("textbox", { name: "Edit selected images" }))
      .toHaveValue("Keep my feedback");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
    await expect
      .element(screen.getByRole("region", { name: "second.png, zoomable image" }))
      .toBeVisible();
    await expect.element(screen.getByText("second.png (2/2)")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next media" }));
    await expect.element(screen.getByText("first.png (1/2)")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains dirty and busy docked edits when another preview or gallery is opened", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await page.viewport(1280, 900);
    let complete = () => {};
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const onApply = vi
      .fn<(item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>>()
      .mockReturnValue(completion);
    const threadKey = "protected-image-editor";
    const images = [
      { src: PIXEL, name: "first.png" },
      { src: PIXEL, name: "other.png" },
    ];
    const content = (sideOpen: boolean) => (
      <AppAtomRegistryProvider>
        <div className="@container/image-workspace relative flex h-[700px] w-full">
          <div>
            <button onClick={() => openExpandedImagePreview(threadKey, { images, index: 0 })}>
              Open first
            </button>
            <button onClick={() => openExpandedImagePreview(threadKey, { images, index: 1 })}>
              Open other
            </button>
            <button
              onClick={() =>
                openExpandedImagePreview(threadKey, { images, index: 0, gallery: true })
              }
            >
              Open gallery
            </button>
            <button onClick={() => openExpandedImagePreview("side-chat", { images, index: 1 })}>
              Open side image
            </button>
          </div>
          <ExpandedImageDialogHost threadKey={threadKey} dockEditor onApply={onApply} />
          {sideOpen && <ExpandedImageDialogHost threadKey="side-chat" dockEditor />}
        </div>
      </AppAtomRegistryProvider>
    );
    await using screen = await render(content(true));
    using _completion = { [Symbol.dispose]: () => complete() };
    await userEvent.click(screen.getByRole("button", { name: "Open first", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    const instructions = screen.getByRole("textbox", { name: "Edit instructions" });
    await expect.element(instructions).toBeEnabled();
    await userEvent.fill(instructions, "Preserve these changes");
    await userEvent.click(screen.getByRole("button", { name: "Open other", exact: true }));
    await expect.element(instructions).toHaveValue("Preserve these changes");
    await userEvent.click(screen.getByRole("button", { name: "Open gallery", exact: true }));
    await expect.element(instructions).toHaveValue("Preserve these changes");
    await userEvent.click(screen.getByRole("button", { name: "Open side image", exact: true }));
    await expect.element(instructions).toHaveValue("Preserve these changes");
    await userEvent.fill(instructions, "");
    await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    await act(() => retainThreadOverlaysForThread("another-route"));
    await expect.element(instructions).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open other", exact: true }));
    await expect.element(instructions).toBeDisabled();
    await act(() => complete());
    await expect.element(instructions).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open other", exact: true }));
    await expect
      .element(screen.getByRole("region", { name: "other.png, zoomable image" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    await userEvent.click(screen.getByRole("button", { name: "Open side image", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit instructions" }), "Side edit");
    await userEvent.click(screen.getByRole("button", { name: "Open first", exact: true }));
    await expect
      .element(screen.getByRole("textbox", { name: "Edit instructions" }))
      .toHaveValue("Side edit");
    await act(() => retainThreadOverlaysForThread(threadKey));
    await expect
      .element(screen.getByRole("textbox", { name: "Edit instructions" }))
      .toHaveValue("Side edit");
    await screen.rerender(content(false));
    await userEvent.click(screen.getByRole("button", { name: "Open first", exact: true }));
    await expect
      .element(screen.getByRole("region", { name: "first.png, zoomable image" }))
      .toBeVisible();
    await act(() => retainThreadOverlaysForThread("another-route"));
    await expect
      .element(screen.getByRole("region", { name: "first.png, zoomable image" }))
      .not.toBeInTheDocument();
  });

  it("allows a same-thread draft redirect while preserving dirty editor work and still blocks leaving", async () => {
    const environmentId = EnvironmentId.make("preview-route-env");
    const threadId = ThreadId.make("preview-route-thread");
    const target = scopeThreadRef(environmentId, threadId);
    const threadKey = scopedThreadKey(target);
    const draftId = DraftId.make("preview-route-draft");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      scopeProjectRef(environmentId, ProjectId.make("preview-route-project")),
      draftId,
      { threadId },
    );
    using _draft = { [Symbol.dispose]: () => store.clearDraftThread(draftId) };
    const root = createRootRoute({
      component: () => (
        <AppAtomRegistryProvider>
          <div className="@container/image-workspace relative flex h-[700px] w-full">
            <ExpandedImageDialogHost threadKey={threadKey} dockEditor />
            <Outlet />
          </div>
        </AppAtomRegistryProvider>
      ),
    });
    const draftRoute = createRoute({ getParentRoute: () => root, path: "draft/$draftId" });
    const threadRoute = createRoute({
      getParentRoute: () => root,
      path: "$environmentId/$threadId",
    });
    const settingsRoute = createRoute({ getParentRoute: () => root, path: "settings" });
    const router = createRouter({
      routeTree: root.addChildren([draftRoute, threadRoute, settingsRoute]),
      history: createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }),
    });
    await router.load();
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await act(() =>
      openExpandedImagePreview(threadKey, {
        images: [{ src: PIXEL, name: "first.png" }],
        index: 0,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    const instructions = screen.getByRole("textbox", { name: "Edit instructions" });
    await expect.element(instructions).toBeEnabled();
    await userEvent.fill(instructions, "Keep this work through promotion");
    await act(() => {
      store.markDraftThreadPromoting(draftId, target);
      store.finalizePromotedDraftThread(draftId);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
        replace: true,
      });
    });
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/${environmentId}/${threadId}`),
    );
    await expect.element(instructions).toHaveValue("Keep this work through promotion");
    using _toast = vi.spyOn(toastManager, "add");
    await act(() => {
      void router.navigate({ to: "/settings" });
    });
    await vi.waitFor(() =>
      expect(_toast).toHaveBeenCalledWith(
        expect.objectContaining({ id: "image-edit-navigation-blocked" }),
      ),
    );
    await expect.element(instructions).toHaveValue("Keep this work through promotion");
    expect(router.state.location.pathname).toBe(`/${environmentId}/${threadId}`);
    await userEvent.click(screen.getByRole("button", { name: "Close image editor", exact: true }));
  });

  it.each([false, true])(
    "keeps dirty modal edits after an outside press (direct edit: %s)",
    async (direct) => {
      const bytes = await (await fetch(PIXEL)).blob();
      const source = URL.createObjectURL(bytes);
      using _source = { [Symbol.dispose]: () => URL.revokeObjectURL(source) };
      let resolveSource!: (response: Response) => void;
      const pendingSource = new Promise<Response>((resolve) => {
        resolveSource = resolve;
      });
      const originalFetch = globalThis.fetch;
      using _fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input, init) =>
          direct && input === source ? pendingSource : originalFetch(input, init),
        );
      const onClose = vi.fn();
      await using screen = await render(
        <DockedImagePreview
          docked={false}
          src={direct ? null : PIXEL}
          edit={direct}
          actionsSource={direct ? { kind: "image", name: "shot.png", src: source } : undefined}
          onClose={onClose}
        />,
      );
      if (direct) {
        await expect
          .element(
            page.getByText("Image unavailable. The file may have been moved or deleted.", {
              exact: true,
            }),
          )
          .not.toBeInTheDocument();
        await expect.element(page.getByRole("status")).toHaveTextContent("Loading image editor…");
        resolveSource(new Response(bytes));
      } else await userEvent.click(page.getByRole("button", { name: "Edit image", exact: true }));
      const instructions = page.getByRole("textbox", { name: "Edit instructions" });
      await expect.element(instructions).toBeEnabled();
      await userEvent.fill(instructions, "Keep this unsaved edit");
      await userEvent.click(
        page.elementLocator(document.querySelector('[data-slot="dialog-viewport"]')!),
        { position: { x: 1, y: 1 } },
      );
      await expect.element(instructions).toHaveValue("Keep this unsaved edit");
      await userEvent.click(page.getByRole("button", { name: "Close image editor" }));
      if (direct) {
        expect(onClose).toHaveBeenCalledOnce();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
        _fetch.mockImplementation((input, init) =>
          input === source
            ? Promise.resolve(new Response(null, { status: 404 }))
            : originalFetch(input, init),
        );
        await screen.rerender(
          <DockedImagePreview
            key="failed-source"
            docked={false}
            src={null}
            edit
            actionsSource={{ kind: "image", name: "shot.png", src: source }}
            onClose={onClose}
          />,
        );
        await expect
          .element(page.getByRole("alert"))
          .toHaveTextContent("The file could not be fetched (HTTP 404).");
        await expect.element(page.getByRole("status")).not.toBeInTheDocument();
        await userEvent.click(page.getByRole("button", { name: "Back, close image editor" }));
        expect(onClose).toHaveBeenCalledTimes(2);
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      } else {
        expect(onClose).not.toHaveBeenCalled();
        await expect
          .element(page.getByRole("button", { name: "Edit image", exact: true }))
          .toBeVisible();
      }
    },
  );

  it("preserves canonical original names through repeated reapplication", async () => {
    const originalFile = new File([await (await fetch(PIXEL)).blob()], "robot.png", {
      type: "image/png",
    });
    const onApply = vi
      .fn<(item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    let item: ExpandedImageItem = {
      src: PIXEL,
      name: "robot-guidance.png",
      editorSession: { originalFile, document: createImageEditorDocument(1, 1) },
    };
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [item], index: 0 }}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass > 0)
        await screen.rerender(
          <ExpandedImageDialog
            key={pass}
            preview={{ images: [item], index: 0 }}
            onApply={onApply}
            onClose={vi.fn()}
          />,
        );
      await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
      await expect.element(screen.getByRole("button", { name: "Add edit request" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
      await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(pass + 1));
      const result = onApply.mock.calls[pass]![1];
      expect(result.originalFile.name).toBe("robot.png");
      expect(result.files[1]!.name).toBe("robot-guidance.png");
      item = {
        src: PIXEL,
        name: result.files[1]!.name,
        editorSession: { originalFile: result.originalFile, document: result.document },
      };
    }
  });

  it("uses the frame-sheet handoff only for its own image after browsing All images", async () => {
    const animationApply = vi
      .fn<(item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    const plainApply = vi
      .fn<(item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    const sheet = { src: PIXEL, name: "animation-frames.png", onApply: animationApply };
    const plain = { src: PIXEL, name: "other.png" };
    const props = {
      preview: { images: [sheet], index: 0 },
      onLoadGallery: async () => [plain],
      onApply: plainApply,
      onClose: vi.fn(),
    };
    await using screen = await render(<ExpandedImageDialog {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await expect.element(screen.getByRole("button", { name: "Add edit request" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
    await vi.waitFor(() => expect(animationApply).toHaveBeenCalledOnce());
    expect(plainApply).not.toHaveBeenCalled();
    await screen.rerender(<ExpandedImageDialog key="browse" {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "All images" }));
    await userEvent.click(screen.getByRole("button", { name: "Open image 1, other.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit image", exact: true }));
    await expect.element(screen.getByRole("button", { name: "Add edit request" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
    await vi.waitFor(() => expect(plainApply).toHaveBeenCalledOnce());
    expect(plainApply.mock.calls[0]![0]).toEqual(plain);
    expect(plainApply.mock.calls[0]![1].mode).toBe("edit");
    expect(animationApply).toHaveBeenCalledOnce();
  });

  it.each([
    { opener: "mouse", focusVisible: false },
    { opener: "keyboard", focusVisible: true },
  ])("returns $opener focus to the opener on close", async (c) => {
    await using screen = await render(<ImagePreviewOpener />, {
      // The opener renders no links and reads no route.
      router: false,
    });
    const opener = screen.getByRole("button", { name: "Open preview" });
    if (c.opener === "mouse") {
      await userEvent.click(opener);
    } else {
      await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Enter}");
    }
    await expect.element(page.getByRole("button", { name: "Close image preview" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(opener).toHaveFocus();
    expect(opener.element().matches(":focus-visible")).toBe(c.focusVisible);
  });

  it.each(["/work/pipeline.svg", "/work/diagram#v2.svg", "/work/diagram?v2.svg"])(
    "fits a markdown SVG without intrinsic size to the viewer: %s",
    async (path) => {
      const src = URL.createObjectURL(new Blob([D2_SVG], { type: "image/svg+xml" }));
      using _src = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
      await using screen = await render(
        <ExpandedImageDialog
          preview={{
            images: [
              {
                src,
                name: "Pipeline",
                actionsSource: {
                  kind: "image",
                  name: "Pipeline",
                  src,
                  reference: { kind: "file", path },
                },
              },
            ],
            index: 0,
          }}
          onClose={vi.fn()}
        />,
        // The dialog renders no links and reads no route.
        { router: false },
      );

      const viewer = screen.getByRole("region", { name: "Pipeline, zoomable image" });
      await vi.waitFor(() => {
        const element = viewer.element();
        const available = element.parentElement!.getBoundingClientRect();
        const image = element.querySelector("img")!;
        const bounds = element.getBoundingClientRect();
        expect(image.naturalHeight).toBeGreaterThan(0);
        expect(bounds.width).toBeCloseTo(
          Math.min(available.width, available.height * (image.naturalWidth / image.naturalHeight)),
          0,
        );
        expect(bounds.height).toBeLessThanOrEqual(available.height);
      });
    },
  );

  it("Escape closes a popup opened inside the dialog before the dialog", async () => {
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
        onClose={onClose}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "No accessibility data" }));
    await expect.element(screen.getByText("Accessibility data")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Accessibility data")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Focus returns to the popup's trigger and opens its tooltip; leave it for a plain control.
    (screen.getByRole("button", { name: "Close image preview" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("scrolling pans the image while Ctrl+wheel zooms around the pointer", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: canvas.toDataURL(), name: "large.png" }], index: 0 }}
        onClose={() => {}}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );
    const viewportLocator = screen.getByRole("region", { name: "large.png, zoomable image" });
    const viewport = viewportLocator.element() as HTMLElement;
    const image = screen.getByRole("img", { name: "large.png" }).element() as HTMLElement;
    await vi.waitFor(() => expect(image.style.width).not.toBe(""));
    const fitWidth = image.getBoundingClientRect().width;
    const wheels: { ctrlKey: boolean; canceled: boolean }[] = [];
    const recordWheel = (event: WheelEvent) =>
      wheels.push({ ctrlKey: event.ctrlKey, canceled: event.defaultPrevented });
    document.addEventListener("wheel", recordWheel);
    using _wheelListener = {
      [Symbol.dispose]: () => document.removeEventListener("wheel", recordWheel),
    };
    // Wheels land on the viewport's center; this is the image fraction under it.
    const pointerFraction = () => {
      const viewportBounds = viewport.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      return {
        x: (viewportBounds.left + viewportBounds.width / 2 - imageBounds.left) / imageBounds.width,
        y: (viewportBounds.top + viewportBounds.height / 2 - imageBounds.top) / imageBounds.height,
      };
    };
    const ctrlWheel = async (deltaY: number) => {
      await userEvent.keyboard("{Control>}");
      await userEvent.wheel(viewportLocator, { delta: { y: deltaY } });
      await userEvent.keyboard("{/Control}");
    };

    await userEvent.wheel(viewportLocator, { delta: { y: 120 } });
    expect(wheels.at(-1)).toEqual({ ctrlKey: false, canceled: false });
    expect(image.getBoundingClientRect().width).toBe(fitWidth);

    await ctrlWheel(-125);
    expect(wheels.at(-1)).toEqual({ ctrlKey: true, canceled: true });
    const zoomedWidth = image.getBoundingClientRect().width;
    expect(zoomedWidth).toBeCloseTo(fitWidth * Math.exp(1.25), 0);
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(60);

    const pan = async (delta: { x: number; y: number }) => {
      const { scrollLeft, scrollTop } = viewport;
      await userEvent.wheel(viewportLocator, { delta });
      await vi.waitFor(() => {
        expect(Math.sign(viewport.scrollLeft - scrollLeft)).toBe(Math.sign(delta.x));
        expect(Math.sign(viewport.scrollTop - scrollTop)).toBe(Math.sign(delta.y));
      });
    };
    await pan({ x: 60, y: 0 });
    await pan({ x: 0, y: 60 });
    await pan({ x: -40, y: -40 });
    expect(wheels.filter((wheel) => !wheel.ctrlKey).every((wheel) => !wheel.canceled)).toBe(true);
    expect(image.getBoundingClientRect().width).toBe(zoomedWidth);

    const anchor = pointerFraction();
    await ctrlWheel(-50);
    expect(image.getBoundingClientRect().width).toBeGreaterThan(zoomedWidth);
    expect(pointerFraction().x).toBeCloseTo(anchor.x, 2);
    expect(pointerFraction().y).toBeCloseTo(anchor.y, 2);
  });
});
