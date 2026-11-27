import { expect } from "e2e";
import JSZip from "jszip";

import { test, WEB } from "./t3.ts";

test(
  "Opening an ODT shows the explicit number on an ordered list",
  WEB,
  async ({ t3, screen, browser }) => {
    const odt = await new JSZip()
      .file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" })
      .file(
        "content.xml",
        `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3">
        <office:automatic-styles><text:list-style style:name="Steps"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style></office:automatic-styles>
        <office:body><office:text><text:list text:style-name="Steps">
          <text:list-item text:start-value="4"><text:p>Review the draft</text:p></text:list-item>
          <text:list-item><text:p>Send the draft</text:p></text:list-item>
        </text:list></office:text></office:body>
      </office:document-content>`,
      )
      .generateAsync({ type: "uint8array" });
    const project = await t3.project("demo", { "steps.odt": odt });
    const thread = await t3.thread({ project, title: "Review steps", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor({ state: "visible" });

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("steps.odt");
    await screen.getByRole("option", "steps.odt", { exact: false }).tap();

    const preview = browser.frameLocator('iframe[title^="steps.odt"]');
    const listSelector = 'ol:has(> li:first-child:has-text("Review the draft"))';
    const list = preview.locator(listSelector);
    const firstItem = preview.locator(`${listSelector} > li:first-child`);
    await firstItem.waitFor({ state: "visible", timeout: 120_000 });
    const start = (await firstItem.getAttribute("value")) ?? (await list.getAttribute("start"));
    expect(Number(start ?? 1)).toBe(4);
  },
);
