/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const LINES = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);

test(
  "The diff expands unchanged lines beside a Git ident keyword",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      ".gitattributes": "notes.txt ident\n",
      "notes.txt": `$Id$\n${LINES.join("\n")}\n`,
    });
    const notes = `${project}/notes.txt`;
    // Checkout smudges `$Id$` to `$Id: <blob> $`; then edit a line inside its hunk.
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(notes);
        yield* run("git", ["checkout-index", "--force", "notes.txt"], { cwd: project });
        const smudged = yield* fs.readFileString(notes);
        yield* fs.writeFileString(notes, smudged.replace("line 2\n", "edited 2\n"));
      }),
    );
    const thread = await t3.thread({ project, title: "Ident", messages: ["first"] });

    // The diff renders in shadow roots that locators do not reach.
    const diffLines = () =>
      browser.evaluate(() =>
        Array.from(document.querySelectorAll("*")).flatMap((host) =>
          Array.from(host.shadowRoot?.querySelectorAll("[data-line]") ?? [], (line) =>
            (line.textContent ?? "").trim(),
          ),
        ),
      );
    const expandBelowHunk = () =>
      browser.evaluate(() => {
        for (const host of document.querySelectorAll("*")) {
          const buttons = host.shadowRoot?.querySelectorAll<HTMLElement>("[data-expand-button]");
          const last = buttons?.[buttons.length - 1];
          if (last) {
            last.click();
            return true;
          }
        }
        return false;
      });

    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Diff").tap();
    await screen.getByRole("button", "Expand notes.txt").tap();
    await expect.poll(diffLines).toContain("edited 2");
    await expect.poll(expandBelowHunk).toBe(true);
    await app.screenshot("after-expand");
    await expect.poll(diffLines).toContain("line 30");
    await app.screenshot("expanded");
  },
);
