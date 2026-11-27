import JSZip from "jszip";
import { expect, it } from "vite-plus/test";

import { sanitizeDocumentHtml } from "./DocumentPages";
import { openDocument } from "./extendedDocumentPreview";

it.each([
  { styleStart: "5", itemStart: undefined, expectedStart: "5", expectedValue: null },
  { styleStart: "0", itemStart: "4", expectedStart: "0", expectedValue: "4" },
  { styleStart: "7", itemStart: "1.5", expectedStart: "7", expectedValue: null },
  { styleStart: "2147483648", itemStart: "4", expectedStart: null, expectedValue: "4" },
])(
  "preserves ODT ordered-list numbering with style start $styleStart and item start $itemStart",
  async ({ styleStart, itemStart, expectedStart, expectedValue }) => {
    const itemAttribute = itemStart === undefined ? "" : ` text:start-value="${itemStart}"`;
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
      xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">
      <office:automatic-styles><text:list-style style:name="Steps">
        <text:list-level-style-number text:level="1" style:num-format="1" text:start-value="${styleStart}"/>
      </text:list-style></office:automatic-styles>
      <office:body><office:text><text:list text:style-name="Steps">
        <text:list-item${itemAttribute}><text:p>Review</text:p></text:list-item>
        <text:list-item><text:p>Send</text:p></text:list-item>
      </text:list></office:text></office:body>
    </office:document-content>`,
    );
    const result = await openDocument(archive, "odt");
    if (result.type !== "document") throw new Error("Expected document");
    const doc = new DOMParser().parseFromString(
      sanitizeDocumentHtml(result.pages[0]!.html),
      "text/html",
    );
    const list = doc.querySelector("ol");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("start")).toBe(expectedStart);
    expect(list?.querySelector(":scope > li")?.getAttribute("value")).toBe(expectedValue);
  },
);
