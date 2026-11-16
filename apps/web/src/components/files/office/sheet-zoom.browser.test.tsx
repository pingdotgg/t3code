import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import JSZip from "jszip";
import { act, render } from "../../../../test/render";
import Spreadsheet from "./Spreadsheet";
import "~/index.css";
it("selects the cell under the pointer after zooming a workbook", async () => {
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Zoom" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>',
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  await using screen = await render(
    <div className="flex h-[400px] w-[600px]">
      <Spreadsheet
        bytes={bytes}
        view={{ hiddenGridlines: [], themeFonts: { major: "Calibri", minor: "Calibri" } }}
        onDetails={() => {}}
        onError={(e) => {
          throw e;
        }}
      />
    </div>,
  );
  const locator = screen.getByRole("grid", { name: "Zoom" });
  await expect.element(locator).toBeVisible();
  const root = locator.element() as HTMLElement;
  const canvas = root.querySelector("canvas")!;
  await vi.waitFor(() => expect(canvas.clientWidth).toBeGreaterThan(0));
  await userEvent.keyboard("{Control>}");
  await userEvent.wheel(locator, { delta: { y: -69.314718 } });
  await userEvent.keyboard("{/Control}");
  await expect.element(screen.getByText("200%", { exact: true })).toBeVisible();
  using _capture = vi.spyOn(root, "setPointerCapture").mockImplementation(() => {});
  using _release = vi.spyOn(root, "releasePointerCapture").mockImplementation(() => {});
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.clientWidth;
  await act(() => {
    const point = {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: rect.left + 120 * scale,
      clientY: rect.top + 30 * scale,
    };
    root.dispatchEvent(new PointerEvent("pointerdown", point));
    root.dispatchEvent(new PointerEvent("pointerup", point));
  });
  await vi.waitFor(() =>
    expect(root.getAttribute("aria-activedescendant")).toBe("office-cell-0-1"),
  );
});
