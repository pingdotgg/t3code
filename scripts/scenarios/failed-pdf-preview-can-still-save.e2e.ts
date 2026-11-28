/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "A PDF can still be saved after its preview fails to open",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const pdf = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readFile("../apps/web/test/fixtures/file-passwords/locked.pdf"),
      ),
    );
    const project = await t3.project("demo", { "report.pdf": pdf });
    const thread = await t3.thread({ project, title: "Review report", messages: ["Start"] });
    const report = `${project}/report.pdf`;
    const backup = `${project}/report-content`;
    const rename = (from: string, to: string) =>
      runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.rename(from, to)));

    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();
    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("report.pdf");
    const result = screen.getByRole("option", "report.pdf", { exact: false });
    await result.waitFor();

    // The file is unavailable when opened from the existing search result, as during a rebuild.
    await rename(report, backup);
    await result.tap();
    await screen.getByText("Unable to load file preview.", { exact: true }).waitFor();
    // The restored path points to readable content that the inline preview still rejects.
    await runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(backup, report)));

    try {
      const save = screen.getByRole("button", "Save file", { exact: true });
      await expect(save).toBeVisible();
      const download = await browser.waitForDownload(() => save.tap());
      expect(download.suggestedFilename).toBe("report.pdf");
      const downloaded = await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(download.absolutePath)),
      );
      expect(Buffer.from(downloaded).equals(pdf)).toBe(true);
    } finally {
      await app.screenshot("failed-pdf-preview");
    }
  },
);
