import { expect } from "e2e";
import JSZip from "jszip";

import { test, WEB } from "./t3.ts";

// A 2 by 2 table stored the compact way ODF allows: one row repeated twice, one cell repeated twice.
async function repeatedTableOdt() {
  const cell =
    '<table:table-cell table:number-columns-repeated="2"><text:p>Approved</text:p></table:table-cell>';
  return new JSZip()
    .file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" })
    .file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><table:table table:name="Decisions"><table:table-column table:number-columns-repeated="2"/><table:table-row table:number-rows-repeated="2">${cell}</table:table-row></table:table></office:text></office:body></office:document-content>`,
    )
    .generateAsync({ type: "uint8array" });
}

test(
  "An ODT preview shows every cell of a table stored with repeated rows and cells",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "decisions.odt": await repeatedTableOdt() });
    const thread = await t3.thread({ project, title: "Review decisions", messages: ["Start"] });
    await t3.open(thread);
    await expect(screen.getByText("fixture turn complete", { exact: false })).toBeVisible();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("decisions.odt");
    await screen.getByRole("option", "decisions.odt", { exact: false }).tap();

    // The first document preview loads its worker, which a cold Vite cache optimizes on demand.
    await expect(screen.getByText("1 page", { exact: false })).toBeVisible({ timeout: 120_000 });
    const document = browser.frameLocator('iframe[title^="decisions.odt"]');
    await expect(document.getByRole("cell", "Approved").first()).toBeVisible();
    await app.screenshot("table");
    await expect(document.getByRole("cell", "Approved")).toHaveCount(4);
  },
);
