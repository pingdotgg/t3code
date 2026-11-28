import JSZip from "jszip";
import { expect, it } from "vite-plus/test";

import { openDocument } from "./extendedDocumentPreview";

const drawing =
  '<draw:frame text:anchor-type="as-char" svg:width="3cm" svg:height="1cm"><draw:text-box><text:p>Recount on Monday</text:p></draw:text-box></draw:frame>';
const nestedDrawing = `<text:list><text:list-item><text:p>Low<text:s/><text:span>${drawing}stock</text:span></text:p></text:list-item></text:list>`;
const drawingOnly = `<text:p>${drawing}</text:p>`;

it.each([
  ["an inline drawing", "", `<text:p>In stock${drawing}</text:p>`, "In stock"],
  ["a drawing inside formatted text", "", drawingOnly + nestedDrawing, "\nLow stock"],
  ["a stored value", 'office:string-value="Available"', drawingOnly.repeat(2), "Available"],
  ["no stored value", "", drawingOnly.repeat(2), undefined],
])("keeps drawing text out of an ODS cell with %s", async (_, value, content, expected) => {
  const archive = new JSZip().file(
    "content.xml",
    `<office:document-content
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
      xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
      xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
      office:version="1.3">
      <office:body><office:spreadsheet><table:table table:name="Stock"><table:table-row>
        <table:table-cell office:value-type="string" ${value}>
          ${content}
        </table:table-cell>
      </table:table-row></table:table></office:spreadsheet></office:body>
    </office:document-content>`,
  );
  const preview = await openDocument(archive, "ods");
  if (preview.type !== "ods") throw new Error("Expected a spreadsheet preview");
  expect(preview.sheets[0]?.rows[0]?.[0]).toBe(expected);
});
