import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runPromise, test, WEB } from "./t3.ts";

const writeNotes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const notes = path.join(yield* fs.makeTempDirectory({ prefix: "question-file-" }), "notes.txt");
  yield* fs.writeFileString(notes, "notes for the question");
  return notes;
});

test(
  "Stopping a question returns its unsent attachment to the composer",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Question with a file",
      messages: ["Ask me something"],
      model: "text-question",
    });
    await t3.open(thread);

    await expect(screen.getByText("What should this replay know", { exact: false })).toBeVisible();
    const notes = await runPromise(writeNotes);
    await browser.locator('input[type="file"]').setInputFiles([notes]);
    await expect(screen.getByText("notes.txt").first()).toBeVisible();
    await app.screenshot("question-with-file");

    await screen.getByRole("button", "Stop generation").tap();
    await expect(screen.getByText("What should this replay know", { exact: false })).toBeHidden();
    await app.screenshot("after-stop");
    await expect(screen.getByText("notes.txt").first()).toBeVisible();
  },
);
