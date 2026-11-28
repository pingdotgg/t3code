/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runPromise, test, WEB } from "./t3.ts";

const LABEL = "Open the generated checklist";
const FILE = "generated-checklist.txt";
const CONTENT = "Example checklist content";

test(
  "A labeled sandbox link opens an absolute file in the thread's right panel",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const destination = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(path.dirname(project), FILE);
        yield* fs.writeFileString(file, CONTENT);
        return `sandbox:${(yield* path.toFileUrl(file)).pathname}`;
      }),
    );
    const thread = await t3.thread({
      project,
      title: "Review generated checklist",
      messages: [`See [${LABEL}](${destination})`],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();

    try {
      const link = screen.getByRole("link", FILE);
      await expect(link).toBeVisible();
      await link.tap();
      await expect
        .poll(() =>
          browser.evaluate(() => {
            const panel = document.querySelector("[data-right-panel-surface-content]");
            for (const host of panel?.querySelectorAll("*") ?? []) {
              const content = host.shadowRoot?.querySelector("[data-content]");
              if (content) return content.textContent ?? "";
            }
            return panel?.textContent ?? "";
          }),
        )
        .toContain(CONTENT);
    } finally {
      await app.screenshot("sandbox-file-preview");
    }
  },
);
