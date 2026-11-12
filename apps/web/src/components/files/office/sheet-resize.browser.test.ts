import { expect, it } from "vite-plus/test";
import JSZip from "jszip";
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
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const client = createWorkerClient<SheetMethods>(
      new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" }),
    );
    try {
      await client.call("open", {
        bytes,
        view: { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } },
      });
      const other = await client.call("position", { sheet: 1, cell: { row: 0, col: 0 } });
      await client.call("resize", { sheet: 0, axis: "column", index: 0, size: 145 });
      await client.call("resize", { sheet: 0, axis: "row", index: 0, size: 60 });
      await expect(
        client.call("resize", { sheet: 0, axis: "row", index: 0, size: maximumTrackSize.row + 1 }),
      ).rejects.toThrow("Invalid track size");
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
    } finally {
      client.close();
    }
  },
);
