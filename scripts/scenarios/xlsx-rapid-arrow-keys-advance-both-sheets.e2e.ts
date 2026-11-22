/// <reference lib="dom" />
import { expect } from "e2e";
import JSZip from "jszip";

import { test, WEB } from "./t3.ts";

const SHEETS = ["Overview", "Actuals", "Forecast"];
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function workbook() {
  const archive = new JSZip();
  const sheets = SHEETS.map(
    (name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="sheet${index + 1}"/>`,
  ).join("");
  archive.file(
    "xl/workbook.xml",
    `<workbook xmlns:r="${RELATIONSHIPS}"><sheets>${sheets}</sheets></workbook>`,
  );
  const relationships = SHEETS.map(
    (_, index) =>
      `<Relationship Id="sheet${index + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  archive.file("xl/_rels/workbook.xml.rels", `<Relationships>${relationships}</Relationships>`);
  for (const [index] of SHEETS.entries())
    archive.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      `<worksheet><sheetData><row r="1"><c r="A1"><v>${index + 1}</v></c></row></sheetData></worksheet>`,
    );
  return archive.generateAsync({ type: "uint8array" });
}

test(
  "Two rapid right arrows advance two tabs in an Excel preview",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "budget.xlsx": await workbook() });
    const thread = await t3.thread({ project, title: "Review budget", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("budget.xlsx");
    await screen.getByRole("option", "budget.xlsx", { exact: false }).tap();
    await browser
      .locator('[data-active-tab="true"]')
      .getByText("budget.xlsx", { exact: true })
      .waitFor();
    // Cold dev servers can reload while optimizing the Office workers.
    await screen.getByRole("tab", "Overview").waitFor({ timeout: 120_000 });

    // Deliver both keystrokes before the worker can report the first sheet switch.
    await browser.evaluate(() => {
      const first = document.querySelector<HTMLButtonElement>(
        '[role="tablist"] [role="tab"][aria-selected="true"]',
      )!;
      first.focus();
      for (let press = 0; press < 2; press++)
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      return null;
    });
    await screen.getByRole("grid", /Actuals|Forecast/).waitFor();
    await app.screenshot("after-two-right-arrows");
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            document
              .querySelector('[role="tablist"]')
              ?.parentElement?.querySelector('[role="grid"]')
              ?.getAttribute("aria-label") ?? null,
        ),
      )
      .toBe("Forecast");
  },
);
