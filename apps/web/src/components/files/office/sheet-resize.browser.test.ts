import { createElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import JSZip from "jszip";
import "~/index.css";
import { act, render } from "../../../../test/render";
import Spreadsheet from "./Spreadsheet";
import { createWorkerClient } from "./worker-rpc";
import type { SheetMethods } from "./sheet-protocol";
import { maximumTrackSize } from "./sheet-sizing";

it.each([false, true])(
  "reflows preview tracks through sheet switches, frozen and hidden tracks: %s",
  async (frozen) => {
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    );
    for (const sheet of [1, 2])
      archive.file(
        `xl/worksheets/sheet${sheet}.xml`,
        `<worksheet>${frozen ? '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" state="frozen" topLeftCell="B2"/></sheetView></sheetViews><cols><col min="2" max="2" width="0" hidden="1"/></cols>' : ""}<sheetData><row r="1"><c r="A1"><v>42</v></c></row>${frozen ? '<row r="2" ht="0" hidden="1"/>' : ""}</sheetData>${frozen ? '<mergeCells><mergeCell ref="A1:C1"/></mergeCells>' : ""}</worksheet>`,
      );
    const namespace = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
    archive.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      '<Relationships><Relationship Id="drawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    );
    archive.file(
      "xl/drawings/drawing1.xml",
      `<xdr:wsDr xmlns:xdr="${namespace}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>13</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Sample chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
    );
    archive.file(
      "xl/drawings/_rels/drawing1.xml.rels",
      '<Relationships><Relationship Id="chart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    );
    archive.file(
      "xl/charts/chart1.xml",
      '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>Sample</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>42</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
    );
    const sheetXml = await archive.file("xl/worksheets/sheet1.xml")!.async("string");
    archive.file(
      "xl/worksheets/sheet1.xml",
      sheetXml.replace(
        "</worksheet>",
        '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="drawing"/></worksheet>',
      ),
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const client = createWorkerClient<SheetMethods>(
      new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" }),
    );
    try {
      const opened = await client.call("open", {
        bytes,
        view: { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } },
      });
      expect(opened!.layout.chartWidth).toBeGreaterThan(0);
      expect(opened!.layout.chartHeight).toBeGreaterThan(0);
      if (frozen) {
        const viewport = {
          sheet: 0,
          width: 400,
          height: 200,
          ratio: 1,
          offset: { x: 0, y: 0 },
          wider: undefined,
        };
        const clipped = await client.call("frame", { ...viewport, x: 32, y: 10 });
        expect(clipped!.grid!.colOffsets[2]! - clipped!.grid!.colOffsets[1]!).toBeCloseTo(32, 0);
        expect(clipped!.grid!.rowOffsets[2]! - clipped!.grid!.rowOffsets[1]!).toBeCloseTo(10, 0);
        clipped!.bitmap.close();
        await client.call("resize", { sheet: 0, axis: "column", index: 2, delta: 1 });
        await client.call("resize", { sheet: 0, axis: "row", index: 2, delta: 1 });
        const resized = await client.call("frame", { ...viewport, x: 0, y: 0 });
        expect(resized!.grid!.colOffsets[2]! - resized!.grid!.colOffsets[1]!).toBeCloseTo(65, 0);
        expect(resized!.grid!.rowOffsets[2]! - resized!.grid!.rowOffsets[1]!).toBeCloseTo(21, 0);
        resized!.bitmap.close();
      }
      const other = await client.call("position", { sheet: 1, cell: { row: 0, col: 0 } });
      const widened = await client.call("resize", {
        sheet: 0,
        axis: "column",
        index: 0,
        delta: 81,
      });
      expect(widened.chartWidth - opened!.layout.chartWidth).toBeCloseTo(frozen ? 1 : 81, 0);
      const taller = await client.call("resize", { sheet: 0, axis: "row", index: 0, delta: 40 });
      expect(taller.chartHeight - opened!.layout.chartHeight).toBeCloseTo(frozen ? 1 : 40, 0);
      await expect(
        client.call("resize", { sheet: 0, axis: "row", index: 0, delta: NaN }),
      ).rejects.toThrow("Invalid track resize");
      expect(await client.call("position", { sheet: 1, cell: { row: 0, col: 0 } })).toEqual(other);
      await client.call("show", { sheet: 1 });
      await client.call("show", { sheet: 0 });
      const position = await client.call("position", { sheet: 0, cell: { row: 0, col: 0 } });
      if (!frozen) {
        expect(position!.next.x - position!.start.x).toBeCloseTo(145, 0);
        expect(position!.next.y - position!.start.y).toBeCloseTo(60, 0);
      }
      expect(
        await client.call("cells", { sheet: 0, range: { top: 0, bottom: 0, left: 0, right: 0 } }),
      ).toEqual([["42"]]);
      const frame = await client.call("frame", {
        sheet: 0,
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        ratio: 1,
        offset: { x: 0, y: 0 },
        wider: undefined,
      });
      expect(frame?.grid?.colOffsets[1]).toBeCloseTo(145, 0);
      expect(frame?.grid?.rowOffsets[1]).toBeCloseTo(60, 0);
      if (frozen) {
        expect(frame?.frozen.width).toBeCloseTo(145, 0);
        expect(frame?.frozen.height).toBeCloseTo(60, 0);
        expect(frame?.grid?.colIndices).not.toContain(1);
        expect(frame?.grid?.rowIndices).not.toContain(1);
      }
      frame?.bitmap.close();
      await client.call("resize", { sheet: 0, axis: "column", index: 0, delta: 10_000 });
      await client.call("resize", { sheet: 0, axis: "row", index: 0, delta: -10_000 });
      const limited = await client.call("frame", {
        sheet: 0,
        x: 0,
        y: 0,
        width: 2000,
        height: 200,
        ratio: 1,
        offset: { x: 0, y: 0 },
        wider: undefined,
      });
      expect(limited!.grid!.colOffsets[1]).toBeCloseTo(maximumTrackSize.column, 0);
      expect(limited!.grid!.rowOffsets[1]).toBeCloseTo(16, 0);
      limited!.bitmap.close();
    } finally {
      client.close();
    }
  },
);

it("requests current dimensions after resizing and scrolling away and back before a frame arrives", async () => {
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sample" sheetId="1" r:id="sheet"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row><row r="1000"><c r="A1000"><v>99</v></c></row></sheetData></worksheet>',
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const container = document.createElement("div");
  Object.assign(container.style, { display: "flex", width: "500px", height: "300px" });
  const onError = vi.fn();
  await using screen = await render(
    createElement(Spreadsheet, {
      bytes,
      view: { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } },
      onDetails: vi.fn(),
      onError,
    }),
    { container },
  );
  await expect.element(screen.getByRole("grid", { name: "Sample" })).toBeVisible();
  const root = screen.getByRole("grid", { name: "Sample" }).element();
  const canvas = root.querySelector("canvas")!;
  await vi.waitFor(() => {
    expect(canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data[0]).toBeGreaterThan(0);
    expect(canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data[0]).toBeLessThan(255);
  });
  const postMessage = Worker.prototype.postMessage;
  const pending: { worker: Worker; message: unknown; options: unknown }[] = [];
  using _frames = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    message: unknown,
    options?: Transferable[] | StructuredSerializeOptions,
  ) {
    if (
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      message.method === "frame"
    ) {
      pending.push({ worker: this, message, options });
      return;
    }
    Reflect.apply(postMessage, this, [message, options]);
  });
  // Synthetic pointer events have no browser pointer to capture.
  using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
  using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
  const rect = canvas.getBoundingClientRect();
  const pointer = { bubbles: true, pointerId: 1, button: 0, clientY: rect.top + 10 };
  await act(() => {
    root.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: rect.left + 108 }));
    root.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: rect.left + 148 }));
    root.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: rect.left + 148 }));
  });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await act(() => root.scrollTo({ top: 2000 }));
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(() => root.scrollTo({ top: 0 }));
  await vi.waitFor(() => expect(pending).toHaveLength(3));
  expect(pending[2]!.message).toMatchObject({ input: { x: 0, y: 0 } });
  const frame = pending[2]!;
  if (typeof frame.message !== "object" || frame.message === null || !("id" in frame.message))
    throw new Error("Missing frame request id");
  frame.worker.dispatchEvent(
    new MessageEvent("message", {
      data: { id: frame.message.id, ok: false, superseded: false, message: "Frame failed" },
    }),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("These cells could not be drawn.");
  await act(() => root.dispatchEvent(new Event("scroll")));
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  const retry = pending[3]!;
  expect(retry.message).toMatchObject({ input: { x: 0, y: 0 } });
  Reflect.apply(postMessage, retry.worker, [retry.message, retry.options]);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  const ratio = window.devicePixelRatio || 1;
  await vi.waitFor(() => {
    expect([
      ...canvas.getContext("2d")!.getImageData(Math.round(140 * ratio), Math.round(5 * ratio), 1, 1)
        .data,
    ]).toEqual([211, 236, 221, 255]);
  });
  expect(onError).not.toHaveBeenCalled();
});
