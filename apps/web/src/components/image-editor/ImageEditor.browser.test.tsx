import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ImageEditor, type ImageEditorResult } from "./ImageEditor";
import {
  addImageEditorObject,
  createImageEditorDocument,
  setImageEditorCrop,
  type ImageEditorObject,
} from "./imageEditorDocument";

const SOURCE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>')}`;

async function pointer(
  canvas: SVGSVGElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
  target: Element = canvas,
) {
  const bounds = canvas.getBoundingClientRect();
  await act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
        clientX: bounds.left + (x / 400) * bounds.width,
        clientY: bounds.top + (y / 300) * bounds.height,
      }),
    );
  });
}

it.each([30])(
  "keeps the first glyph anchored when typing into text rotated %s degrees",
  async (rotation) => {
    await using screen = await render(
      <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    await expect.element(screen.getByRole("button", { name: "Text", exact: true })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Text", exact: true }));
    const canvas = screen.getByRole("application", { name: "Editable annotations" });
    await userEvent.click(canvas, { position: { x: 140, y: 100 } });
    const inlineText = page.getByRole("textbox", { name: "Annotation text", exact: true });
    await expect.element(inlineText).toHaveFocus();
    const textInput = inlineText.element() as HTMLTextAreaElement;
    expect([textInput.selectionStart, textInput.selectionEnd]).toEqual([0, 4]);
    await userEvent.keyboard("Text{Enter}");
    await expect.element(inlineText).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("textbox", { name: "Text content", exact: true }))
      .toHaveValue("Text");
    await userEvent.fill(
      screen.getByRole("spinbutton", { name: "Rotation", exact: true }),
      String(rotation),
    );
    const origin = () => {
      const text = canvas.element().querySelector("text")!;
      const point = text.getStartPositionOfChar(0);
      return new DOMPoint(point.x, point.y).matrixTransform(text.getScreenCTM()!);
    };
    const before = origin();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Text content", exact: true }),
      "Text with a much longer annotation",
    );
    const after = origin();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  },
);

it("draws, moves and resizes an annotation at image resolution and exports the resulting pixels", async () => {
  let complete = () => {};
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onApply = vi.fn<(result: ImageEditorResult) => Promise<void>>().mockReturnValue(completion);
  await using screen = await render(
    <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={onApply} />,
  );
  using _completion = { [Symbol.dispose]: () => complete() };
  await expect
    .element(screen.getByRole("button", { name: "Rectangle", exact: true }))
    .toBeEnabled();
  const canvas = screen
    .getByRole("application", { name: "Editable annotations" })
    .element() as SVGSVGElement;
  // Synthetic pointers have no active browser capture target.
  using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: "Rectangle", exact: true }));
  await pointer(canvas, "pointerdown", 100, 80);
  await pointer(canvas, "pointermove", 200, 150);
  await pointer(canvas, "pointerup", 200, 150);
  await userEvent.click(screen.getByRole("button", { name: "Select and move" }));
  await pointer(canvas, "pointerdown", 100, 100);
  await pointer(canvas, "pointermove", 130, 120);
  await pointer(canvas, "pointerup", 130, 120);
  const handle = canvas.querySelector('[data-resize="true"]');
  expect(handle).not.toBeNull();
  await pointer(canvas, "pointerdown", 230, 170, handle!);
  await pointer(canvas, "pointermove", 280, 200);
  await pointer(canvas, "pointerup", 280, 200);
  await expect
    .element(screen.getByRole("spinbutton", { name: "Width", exact: true }))
    .toHaveValue(150);
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  await expect
    .element(screen.getByRole("spinbutton", { name: "Width", exact: true }))
    .toHaveValue(100);
  await userEvent.click(screen.getByRole("button", { name: "Redo image edit" }));
  await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  await expect
    .element(screen.getByRole("spinbutton", { name: "Width", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByRole("textbox", { name: "Edit instructions" })).toBeDisabled();
  await act(() => canvas.focus());
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect
    .element(screen.getByRole("spinbutton", { name: "Width", exact: true }))
    .toHaveValue(150);
  const result = onApply.mock.calls[0]![0];
  expect(result.mode).toBe("edit");
  const annotation = result.document.objects[0]!;
  expect(annotation.x).toBeCloseTo(130);
  expect(annotation.y).toBeCloseTo(100);
  expect(annotation.width).toBeCloseTo(150);
  expect(annotation.height).toBeCloseTo(100);
  expect(result.originalFile.type).toBe("image/svg+xml");
  const bitmap = await createImageBitmap(result.files[1]!);
  expect([bitmap.width, bitmap.height]).toEqual([400, 300]);
  const raster = document.createElement("canvas");
  raster.width = bitmap.width;
  raster.height = bitmap.height;
  const context = raster.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  expect([...context.getImageData(130, 130, 1, 1).data]).toEqual([239, 68, 68, 255]);
  expect([...context.getImageData(20, 20, 1, 1).data]).toEqual([255, 255, 255, 255]);
  await act(() => complete());
});

it.each(["pin", "freehand", "rectangle"] as const)(
  "moves a small selected %s from its center without intercepting the drag with its resize handle",
  async (kind) => {
    const object: ImageEditorObject = {
      id: "small",
      x: 400,
      y: 400,
      width: kind === "pin" ? 32 : kind === "freehand" ? 1 : 8,
      height: kind === "pin" ? 32 : kind === "freehand" ? 1 : 8,
      rotation: kind === "rectangle" ? 30 : 0,
      color: "#ef4444",
      strokeWidth: 8,
      ...(kind === "pin"
        ? { kind, comment: "Move this location" }
        : kind === "freehand"
          ? { kind, points: [{ x: 0, y: 0 }] }
          : { kind }),
    };
    const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254"><rect width="1254" height="1254" fill="white"/></svg>')}`;
    await using screen = await render(
      <div className="w-[480px]">
        <ImageEditor
          src={source}
          name="large.svg"
          initialDocument={addImageEditorObject(createImageEditorDocument(1254, 1254), object)}
          onCancel={vi.fn()}
          onApply={vi.fn()}
        />
      </div>,
    );
    const propertyRow = screen
      .getByRole("group", { name: "Image edit properties" })
      .getByRole("button", {
        name: kind === "pin" ? "Comment 1" : kind === "freehand" ? "Freehand" : "Rectangle",
        exact: true,
      });
    await userEvent.click(propertyRow);
    const canvas = screen.getByRole("application", { name: "Editable annotations" });
    const bounds = canvas.element().getBoundingClientRect();
    const sourceX = ((object.x + object.width / 2) / 1254) * bounds.width;
    const sourceY = ((object.y + object.height / 2) / 1254) * bounds.height;
    expect((object.width / 1254) * bounds.width).toBeLessThan(12);
    await userEvent.dragAndDrop(canvas, canvas, {
      sourcePosition: { x: sourceX, y: sourceY },
      targetPosition: {
        x: sourceX + (80 / 1254) * bounds.width,
        y: sourceY + (60 / 1254) * bounds.height,
      },
    });
    await expect
      .poll(() =>
        Number(
          (
            screen
              .getByRole("spinbutton", { name: "Position X", exact: true })
              .element() as HTMLInputElement
          ).value,
        ),
      )
      .toBeCloseTo(480, 0);
    await expect
      .poll(() =>
        Number(
          (
            screen
              .getByRole("spinbutton", { name: "Position Y", exact: true })
              .element() as HTMLInputElement
          ).value,
        ),
      )
      .toBeCloseTo(460, 0);
    await expect
      .element(screen.getByRole("spinbutton", { name: "Width", exact: true }))
      .toHaveValue(object.width);
    await expect
      .element(screen.getByRole("spinbutton", { name: "Height", exact: true }))
      .toHaveValue(object.height);
  },
);

it("groups a long focused comment edit into one undo step and keeps earlier drawing history", async () => {
  const onDirtyChange = vi.fn();
  const onCancel = vi.fn();
  const onApply = vi
    .fn<(result: ImageEditorResult) => Promise<void>>()
    .mockResolvedValue(undefined);
  await using screen = await render(
    <ImageEditor
      src={SOURCE}
      name="source.svg"
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
      onApply={onApply}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Rectangle", exact: true }))
    .toBeEnabled();
  const canvas = screen
    .getByRole("application", { name: "Editable annotations" })
    .element() as SVGSVGElement;
  using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: "Rectangle", exact: true }));
  expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
  await pointer(canvas, "pointerdown", 20, 20);
  expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(true);
  await pointer(canvas, "pointermove", 90, 70);
  await pointer(canvas, "pointercancel", 90, 70);
  expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
  await pointer(canvas, "pointerdown", 20, 20);
  await pointer(canvas, "pointermove", 90, 70);
  await pointer(canvas, "pointerup", 90, 70);
  await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
  await pointer(canvas, "pointerdown", 180, 100);
  const inlineComment = page.getByRole("textbox", { name: "Annotation comment", exact: true });
  await expect.element(inlineComment).toHaveFocus();
  for (const composingKey of [
    { key: "Enter", keyCode: 229 },
    { key: "Escape", isComposing: true },
    { key: "Escape", keyCode: 229 },
  ]) {
    const keyEvent = new KeyboardEvent("keydown", {
      ...composingKey,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      inlineComment.element().dispatchEvent(keyEvent);
    });
    expect(keyEvent.defaultPrevented).toBe(false);
    await expect.element(inlineComment).toHaveFocus();
  }
  const comment = screen.getByRole("textbox", { name: "Comment", exact: true });
  const message =
    "A long location comment keeps all earlier annotations undoable even after more than eighty individual keystrokes.";
  await userEvent.keyboard(message);
  await expect.element(inlineComment).toHaveValue(message);
  await expect.element(comment).toHaveValue(message);
  await userEvent.keyboard("{Escape}");
  await expect.element(inlineComment).not.toBeInTheDocument();
  expect(onCancel).not.toHaveBeenCalled();
  await expect.element(page.elementLocator(canvas)).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  await expect.element(comment).toHaveValue("");
  expect(canvas.querySelector("circle")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(canvas.querySelector("circle")).toBeNull();
  expect(canvas.querySelector("g[pointer-events] rect")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(canvas.querySelector("g[pointer-events] rect")).toBeNull();
  expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
  await pointer(canvas, "pointerdown", 385, 285);
  await expect.element(inlineComment).toHaveFocus();
  await userEvent.keyboard("Make this green{Shift>}{Enter}{/Shift}Only here{Enter}");
  await expect.element(inlineComment).not.toBeInTheDocument();
  await expect.element(comment).toHaveValue("Make this green\nOnly here");
  expect(onCancel).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(onApply.mock.calls[0]![0].prompt).toContain("Make this green\nOnly here");
});

it("groups numeric keystrokes by focused property and separates edits to different fields", async () => {
  await using screen = await render(
    <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={vi.fn()} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Rectangle", exact: true }))
    .toBeEnabled();
  const canvas = screen
    .getByRole("application", { name: "Editable annotations" })
    .element() as SVGSVGElement;
  using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: "Rectangle", exact: true }));
  await pointer(canvas, "pointerdown", 20, 20);
  await pointer(canvas, "pointermove", 90, 70);
  await pointer(canvas, "pointerup", 90, 70);
  const width = screen.getByRole("spinbutton", { name: "Width", exact: true });
  const height = screen.getByRole("spinbutton", { name: "Height", exact: true });
  await userEvent.fill(width, "1");
  await userEvent.keyboard("23");
  await userEvent.fill(height, "4");
  await userEvent.keyboard("5");
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  await expect.element(width).toHaveValue(123);
  await expect.element(height).toHaveValue(50);
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  await expect.element(width).toHaveValue(70);
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(canvas.querySelector("g[pointer-events] rect")).toBeNull();
});

it("sizes annotations for the fitted view with separate writing and highlighting sliders", async () => {
  const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2880" height="1800"><rect width="2880" height="1800" fill="white"/></svg>')}`;
  const onApply = vi
    .fn<(result: ImageEditorResult) => Promise<void>>()
    .mockResolvedValue(undefined);
  await using screen = await render(
    <div className="h-[650px] w-[480px]">
      <ImageEditor src={source} name="retina.svg" onCancel={vi.fn()} onApply={onApply} />
    </div>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Comment pin", exact: true }))
    .toBeEnabled();
  const canvas = screen.getByRole("application", { name: "Editable annotations" });
  const strokeSize = screen.getByRole("slider", { name: "Stroke size", exact: true });
  await expect.element(strokeSize).toHaveValue("3");

  await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
  await userEvent.click(canvas, { position: { x: 60, y: 60 } });
  const width = Number(
    (screen.getByRole("spinbutton", { name: "Width", exact: true }).element() as HTMLInputElement)
      .value,
  );
  const ratio = canvas.element().getBoundingClientRect().width / 2880;
  expect(width * ratio).toBeCloseTo(24, 1);
  await expect.element(strokeSize).toHaveValue("3");
  await userEvent.click(
    screen.getByRole("button", { name: "Delete selected annotation", exact: true }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Draw", exact: true }));
  await userEvent.dragAndDrop(canvas, canvas, {
    sourcePosition: { x: 130, y: 80 },
    targetPosition: { x: 230, y: 100 },
  });
  await userEvent.click(screen.getByRole("button", { name: "Rectangle", exact: true }));
  await expect.element(strokeSize).toHaveValue("3");
  await userEvent.click(strokeSize);
  await userEvent.keyboard("{End}");
  await expect.element(strokeSize).toHaveValue("30");
  await userEvent.dragAndDrop(canvas, canvas, {
    sourcePosition: { x: 70, y: 70 },
    targetPosition: { x: 170, y: 130 },
  });
  await userEvent.click(screen.getByRole("button", { name: "Draw", exact: true }));
  await expect.element(strokeSize).toHaveValue("3");
  await userEvent.click(strokeSize);
  await userEvent.keyboard("{Home}");
  await expect.element(strokeSize).toHaveValue("2");
  await userEvent.keyboard("{End}");
  await expect.element(strokeSize).toHaveValue("10");
  await userEvent.dragAndDrop(canvas, canvas, {
    sourcePosition: { x: 130, y: 120 },
    targetPosition: { x: 230, y: 140 },
  });
  await userEvent.click(screen.getByRole("button", { name: "Removal brush", exact: true }));
  const brushSize = screen.getByRole("slider", { name: "Removal brush size", exact: true });
  await expect.element(brushSize).toHaveValue("3");
  await userEvent.click(brushSize);
  await userEvent.keyboard("{End}");
  await userEvent.dragAndDrop(canvas, canvas, {
    sourcePosition: { x: 70, y: 40 },
    targetPosition: { x: 170, y: 60 },
  });
  await userEvent.click(screen.getByRole("button", { name: "Select and move", exact: true }));
  await expect.element(brushSize).toHaveValue("30");
  await userEvent.click(brushSize);
  await userEvent.keyboard("{Home}");
  await expect.element(brushSize).toHaveValue("2");
  await userEvent.click(screen.getByRole("button", { name: "Add edit request", exact: true }));
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  const objects = onApply.mock.calls[0]![0].document.objects;
  expect(objects.map((object) => object.kind)).toEqual([
    "freehand",
    "rectangle",
    "freehand",
    "remove",
  ]);
  for (const [index, size] of [3, 30, 10, 2].entries())
    expect(objects[index]!.strokeWidth * ratio).toBeCloseTo(size, 1);
});

it.each([0, 80, -80])(
  "remeasures multiline typography and renders the final glyph within text bounds with curve %s",
  async (curve) => {
    const onApply = vi
      .fn<(result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    await using screen = await render(
      <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={onApply} />,
    );
    await expect.element(screen.getByRole("button", { name: "Text", exact: true })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Text", exact: true }));
    const canvas = screen
      .getByRole("application", { name: "Editable annotations" })
      .element() as SVGSVGElement;
    using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
    await pointer(canvas, "pointerdown", 15, 30);
    const originalWidth = Number(
      (screen.getByRole("spinbutton", { name: "Width", exact: true }).element() as HTMLInputElement)
        .value,
    );
    await userEvent.fill(screen.getByRole("spinbutton", { name: "Text size", exact: true }), "12");
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Text content", exact: true }),
      "Measured text ends with Z\nSecond line Z",
    );
    await userEvent.fill(
      screen.getByRole("spinbutton", { name: "Letter spacing", exact: true }),
      "1",
    );
    await userEvent.fill(
      screen.getByRole("spinbutton", { name: "Word spacing", exact: true }),
      "2",
    );
    await userEvent.fill(
      screen.getByRole("spinbutton", { name: "Line height", exact: true }),
      "1.8",
    );
    await userEvent.fill(
      screen.getByRole("spinbutton", { name: "Character width", exact: true }),
      "1.1",
    );
    if (curve)
      await userEvent.fill(
        screen.getByRole("spinbutton", { name: "Text curve", exact: true }),
        String(curve),
      );
    const width = Number(
      (screen.getByRole("spinbutton", { name: "Width", exact: true }).element() as HTMLInputElement)
        .value,
    );
    const height = Number(
      (
        screen
          .getByRole("spinbutton", { name: "Height", exact: true })
          .element() as HTMLInputElement
      ).value,
    );
    expect(width).toBeGreaterThan(originalWidth);
    const objectGroup = canvas.querySelector("g[pointer-events] > g") as SVGGElement;
    const bounds = objectGroup.getBBox();
    expect(bounds.x).toBeGreaterThanOrEqual(-0.01);
    expect(bounds.y).toBeGreaterThanOrEqual(-0.01);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 0.1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 0.1);
    const text = objectGroup.querySelector("text")!;
    const lastGlyph = text.getExtentOfChar(text.getNumberOfChars() - 1);
    expect(lastGlyph.width).toBeGreaterThan(0);
    expect(text.getEndPositionOfChar(text.getNumberOfChars() - 1).x).toBeGreaterThan(0);
    const matrix = canvas.getScreenCTM()!.inverse().multiply(text.getScreenCTM()!);
    const corners = [
      new DOMPoint(lastGlyph.x, lastGlyph.y),
      new DOMPoint(lastGlyph.x + lastGlyph.width, lastGlyph.y + lastGlyph.height),
    ].map((point) => point.matrixTransform(matrix));
    const glyphX = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
    const glyphY = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
    const glyphRight = Math.ceil(Math.max(...corners.map((point) => point.x)));
    const glyphBottom = Math.ceil(Math.max(...corners.map((point) => point.y)));
    expect(glyphRight).toBeLessThanOrEqual(400);
    expect(glyphBottom).toBeLessThanOrEqual(300);
    await userEvent.click(screen.getByRole("button", { name: "Add edit request", exact: true }));
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const result = onApply.mock.calls[0]![0];
    const bitmap = await createImageBitmap(result.files[1]!);
    const raster = window.document.createElement("canvas");
    raster.width = bitmap.width;
    raster.height = bitmap.height;
    const context = raster.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(
      glyphX,
      glyphY,
      glyphRight - glyphX,
      glyphBottom - glyphY,
    ).data;
    expect(
      Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4 + 1]).some(
        (green) => green! < 150,
      ),
    ).toBe(true);
  },
);

it.each(["draw", "move", "resize", "erase", "crop"])(
  "rolls back an interrupted %s gesture and accepts the next gesture without adding canceled history",
  async (operation) => {
    const initialDocument = addImageEditorObject(createImageEditorDocument(400, 300), {
      id: "existing",
      kind: "rectangle",
      x: 40,
      y: 50,
      width: 100,
      height: 80,
      rotation: 0,
      color: "#ef4444",
      strokeWidth: 8,
    });
    const onApply = vi
      .fn<(result: ImageEditorResult) => Promise<void>>()
      .mockResolvedValue(undefined);
    await using screen = await render(
      <ImageEditor
        src={SOURCE}
        name="source.svg"
        initialDocument={initialDocument}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );
    const canvas = screen
      .getByRole("application", { name: "Editable annotations" })
      .element() as SVGSVGElement;
    // Synthetic pointercancel exercises rollback independently of native capture ownership.
    using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
    const propertyRow = screen
      .getByRole("group", { name: "Image edit properties" })
      .getByRole("button", { name: "Rectangle", exact: true });
    await expect.element(propertyRow).toBeEnabled();
    if (operation === "move" || operation === "resize") await userEvent.click(propertyRow);
    else
      await userEvent.click(
        screen.getByRole("toolbar", { name: "Image editing tools" }).getByRole("button", {
          name:
            operation === "draw"
              ? "Rectangle"
              : operation === "erase"
                ? "Erase annotations"
                : "Crop",
          exact: true,
        }),
      );
    const target = operation === "resize" ? canvas.querySelector('[data-resize="true"]')! : canvas;
    const start =
      operation === "resize"
        ? { x: 140, y: 130 }
        : operation === "draw" || operation === "crop"
          ? { x: 200, y: 160 }
          : { x: 40, y: 70 };
    await pointer(canvas, "pointerdown", start.x, start.y, target);
    await pointer(canvas, "pointermove", start.x + 60, start.y + 50);
    if (operation === "draw")
      await expect
        .element(screen.getByRole("heading", { name: "Staged changes (2)" }))
        .toBeVisible();
    else if (operation === "erase")
      await expect
        .element(screen.getByRole("heading", { name: "Staged changes (0)" }))
        .toBeVisible();
    else if (operation === "crop")
      await expect
        .element(screen.getByRole("button", { name: "Revert crop", exact: true }))
        .toBeVisible();
    else
      await expect
        .element(
          screen.getByRole("spinbutton", {
            name: operation === "move" ? "Position X" : "Width",
            exact: true,
          }),
        )
        .toHaveValue(operation === "move" ? 100 : 160);
    await pointer(canvas, "pointercancel", start.x + 60, start.y + 50);
    await pointer(canvas, "pointerup", start.x + 60, start.y + 50);
    await expect.element(screen.getByRole("heading", { name: "Staged changes (1)" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Undo image edit" })).toBeDisabled();
    expect(canvas.querySelectorAll('g[pointer-events="none"] > g')).toHaveLength(1);
    await userEvent.click(
      screen
        .getByRole("toolbar", { name: "Image editing tools" })
        .getByRole("button", { name: "Rectangle", exact: true }),
    );
    await pointer(canvas, "pointerdown", 200, 160);
    await pointer(canvas, "pointermove", 260, 210);
    await pointer(canvas, "pointerup", 260, 210);
    await expect.element(screen.getByRole("heading", { name: "Staged changes (2)" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const result = onApply.mock.calls[0]![0];
    expect(result.document.objects).toHaveLength(2);
    expect(result.document.objects[0]).toEqual(initialDocument.objects[0]);
    expect(result.document.crop).toBeNull();
    const next = result.document.objects[1]!;
    expect(next.x).toBeCloseTo(200);
    expect(next.y).toBeCloseTo(160);
    expect(next.width).toBeCloseTo(60);
    expect(next.height).toBeCloseTo(50);
  },
);

it.each(["right"] as const)(
  "ignores a real %s-button press on the drawing surface",
  async (button) => {
    await using screen = await render(
      <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    const canvas = screen.getByRole("application", { name: "Editable annotations" });
    await expect.element(screen.getByRole("button", { name: "Draw", exact: true })).toBeEnabled();
    await userEvent.click(canvas, { button });
    await expect.element(screen.getByRole("heading", { name: "Staged changes (0)" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Undo image edit" })).toBeDisabled();
    expect(canvas.element().querySelector('g[pointer-events="none"]')?.childElementCount).toBe(0);
  },
);

it("keeps a native drag captured when the pointer leaves the image and releases outside its bounds", async () => {
  await using screen = await render(
    <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={vi.fn()} />,
  );
  await userEvent.click(
    screen
      .getByRole("toolbar", { name: "Image editing tools" })
      .getByRole("button", { name: "Rectangle", exact: true }),
  );
  const canvas = screen.getByRole("application", { name: "Editable annotations" });
  const controls = screen.getByRole("group", { name: "Image edit properties" });
  const sourceBounds = canvas.element().getBoundingClientRect();
  const targetBounds = controls.element().getBoundingClientRect();
  const destinationX = targetBounds.left + targetBounds.width / 2;
  const destinationY = targetBounds.top + targetBounds.height / 2;
  expect(destinationY).toBeGreaterThan(sourceBounds.bottom);
  await userEvent.dragAndDrop(canvas, controls, {
    sourcePosition: { x: sourceBounds.width / 4, y: sourceBounds.height / 4 },
    targetPosition: { x: targetBounds.width / 2, y: targetBounds.height / 2 },
  });
  await expect.element(screen.getByRole("heading", { name: "Staged changes (1)" })).toBeVisible();
  const markup = canvas.element().querySelector('g[pointer-events="none"] > g > rect');
  expect(markup).not.toBeNull();
  const expectedWidth =
    Math.min(400, Math.max(0, ((destinationX - sourceBounds.left) / sourceBounds.width) * 400)) -
    100;
  expect(Number(markup!.getAttribute("width"))).toBeCloseTo(expectedWidth);
  const expectedHeight =
    Math.min(300, Math.max(0, ((destinationY - sourceBounds.top) / sourceBounds.height) * 300)) -
    75;
  expect(Number(markup!.getAttribute("height"))).toBeCloseTo(expectedHeight);
  await userEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  await expect.element(screen.getByRole("heading", { name: "Staged changes (0)" })).toBeVisible();
});

it.each([
  "Backspace",
  "Delete selected annotation",
  "Revert Rectangle",
  "Revert crop",
  "Reset all image edits",
])("keeps keyboard history reachable after %s removes focused edits", async (action) => {
  const initialDocument = setImageEditorCrop(
    addImageEditorObject(createImageEditorDocument(400, 300), {
      id: "rectangle",
      kind: "rectangle",
      x: 40,
      y: 50,
      width: 100,
      height: 80,
      rotation: 0,
      color: "#ef4444",
      strokeWidth: 8,
    }),
    { x: 10, y: 20, width: 300, height: 200 },
  );
  await using screen = await render(
    <ImageEditor
      src={SOURCE}
      name="source.svg"
      initialDocument={initialDocument}
      onCancel={vi.fn()}
      onApply={vi.fn()}
    />,
  );
  const row = screen
    .getByRole("group", { name: "Image edit properties" })
    .getByRole("button", { name: "Rectangle", exact: true });
  await expect.element(row).toBeEnabled();
  await userEvent.click(row);
  if (action === "Backspace" || action === "Delete") await userEvent.keyboard(`{${action}}`);
  else await userEvent.click(screen.getByRole("button", { name: action, exact: true }));
  const remaining = action === "Reset all image edits" ? 0 : 1;
  const afterRemoval = screen.getByRole("heading", { name: `Staged changes (${remaining})` });
  await expect.element(afterRemoval).toBeVisible();
  await expect
    .element(screen.getByRole("application", { name: "Editable annotations" }))
    .toHaveFocus();
  await userEvent.keyboard("{Meta>}z{/Meta}");
  await expect.element(screen.getByRole("heading", { name: "Staged changes (2)" })).toBeVisible();
  await expect.element(row).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Revert crop", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Meta>}y{/Meta}");
  await expect.element(afterRemoval).toBeVisible();
  await userEvent.keyboard("{Meta>}z{/Meta}");
  await expect.element(screen.getByRole("heading", { name: "Staged changes (2)" })).toBeVisible();
  await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
  await expect.element(afterRemoval).toBeVisible();
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(screen.getByRole("heading", { name: "Staged changes (2)" })).toBeVisible();
  await expect.element(row).toBeVisible();
});

it("requires still-frame confirmation when opaque metadata hides the original GIF bytes", async () => {
  const gif = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255, 33, 249, 4, 0, 10, 0, 0, 0,
    44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 33, 249, 4, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0,
    1, 0, 0, 2, 2, 76, 1, 0, 59,
  ]);
  const source = URL.createObjectURL(new Blob([gif], { type: "application/octet-stream" }));
  using _source = { [Symbol.dispose]: () => URL.revokeObjectURL(source) };
  const onApply = vi
    .fn<(result: ImageEditorResult) => Promise<void>>()
    .mockResolvedValue(undefined);
  await using screen = await render(
    <ImageEditor
      src={source}
      name="opaque-image"
      mimeType="application/octet-stream"
      onCancel={vi.fn()}
      onApply={onApply}
    />,
  );
  const apply = screen.getByRole("button", { name: "Add edit request" });
  await expect.element(apply).toBeEnabled();
  await userEvent.click(apply);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "This is a GIF. Choose Edit a still frame to create a PNG. To work on the animation, save it with a .gif filename and reopen it from the gallery.",
    );
  expect(onApply).not.toHaveBeenCalled();
  await expect.element(apply).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Edit a still frame" }));
  await expect.element(apply).toBeEnabled();
  await userEvent.click(apply);
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  const result = onApply.mock.calls[0]![0];
  expect(new Uint8Array(await result.originalFile.arrayBuffer())).toEqual(gif);
  expect(result.files[0]!.type).toBe("image/png");
});

it("stages location comments, brush guidance and generation instructions without discarding edits on a failed handoff", async () => {
  const onApply = vi
    .fn<(result: ImageEditorResult) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Message has too many attachments"))
    .mockResolvedValue(undefined);
  await using screen = await render(
    <ImageEditor src={SOURCE} name="source.svg" onCancel={vi.fn()} onApply={onApply} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Comment pin", exact: true }))
    .toBeEnabled();
  const canvas = screen
    .getByRole("application", { name: "Editable annotations" })
    .element() as SVGSVGElement;
  // Synthetic pointers have no active browser capture target.
  using _capture = vi.spyOn(canvas, "setPointerCapture").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("button", { name: "Comment pin", exact: true }));
  await pointer(canvas, "pointerdown", 60, 70);
  await pointer(canvas, "pointerup", 60, 70);
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Comment", exact: true }),
    "Replace the lamp",
  );
  await userEvent.click(screen.getByRole("button", { name: "Removal brush", exact: true }));
  await pointer(canvas, "pointerdown", 230, 140);
  await pointer(canvas, "pointermove", 270, 160);
  await pointer(canvas, "pointerup", 270, 160);
  await userEvent.click(screen.getByRole("button", { name: "Remove background", exact: true }));
  await userEvent.click(screen.getByRole("combobox", { name: "Regenerate aspect ratio" }));
  await userEvent.click(page.getByRole("option", { name: "Portrait · 4:5" }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Edit instructions" }),
    "Use warm lighting",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Message has too many attachments");
  await expect.element(screen.getByRole("button", { name: "Add edit request" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Add edit request" }));
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
  const result = onApply.mock.calls[1]![0];
  expect(result.mode).toBe("edit");
  expect(result.files.map((file) => file.name)).toEqual([
    "source-original.png",
    "source-guidance.png",
    "source-mask.png",
  ]);
  expect(result.prompt).toContain("Replace the lamp");
  expect(result.prompt).toContain("Use warm lighting");
  expect(result.prompt).toContain("4:5 aspect ratio");
  expect(result.prompt).toContain("transparent background");
  expect(result.document.objects.map((object) => object.kind)).toEqual(["pin", "remove"]);
});
