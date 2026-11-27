import JSZip from "jszip";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { OfficeFilePreview } from "./OfficeFilePreview";

it.each([
  { styleStart: "5", itemStart: undefined, expectedStart: "5", expectedValue: null },
  { styleStart: "0", itemStart: "4", expectedStart: "0", expectedValue: "4" },
  { styleStart: "7", itemStart: "1.5", expectedStart: "7", expectedValue: null },
  { styleStart: undefined, itemStart: "4", expectedStart: null, expectedValue: "4" },
])(
  "preserves ODT ordered-list numbering with style start $styleStart and item start $itemStart",
  async ({ styleStart, itemStart, expectedStart, expectedValue }) => {
    const itemAttribute = itemStart === undefined ? "" : ` text:start-value="${itemStart}"`;
    const styleAttribute = styleStart === undefined ? "" : ` text:start-value="${styleStart}"`;
    const archive = await new JSZip()
      .file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" })
      .file(
        "content.xml",
        `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
      xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">
      <office:automatic-styles><text:list-style style:name="Steps">
        <text:list-level-style-number text:level="1" style:num-format="1"${styleAttribute}/>
      </text:list-style></office:automatic-styles>
      <office:body><office:text><text:list text:style-name="Steps">
        <text:list-item${itemAttribute}><text:p>Review the draft</text:p></text:list-item>
        <text:list-item><text:p>Send the draft</text:p></text:list-item>
      </text:list></office:text></office:body>
    </office:document-content>`,
      )
      .generateAsync({ type: "base64" });
    await using screen = await render(
      <OfficeFilePreview
        src={`data:application/octet-stream;base64,${archive}`}
        name="steps.odt"
        kind="odt"
      />,
    );
    const preview = screen.getByTitle("steps.odt: Page 1");
    await expect.element(preview).toBeInTheDocument();
    const frame = preview.element();
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Expected a preview iframe");
    // The sandbox makes the iframe's document inaccessible to the parent.
    const document = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    const list = [...document.querySelectorAll("ol")].find(
      (list) => list.firstElementChild?.textContent === "Review the draft",
    );
    expect(list).toBeDefined();
    expect(list?.getAttribute("start")).toBe(expectedStart);
    expect(list?.querySelector(":scope > li:first-child")?.getAttribute("value")).toBe(
      expectedValue,
    );
  },
);
