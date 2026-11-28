import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "Expanding visible diffs keeps a hidden test file folded",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", {
      "notes.txt": "Old implementation notes\n",
      "notes.test.ts": "const expected = 1;\n",
    });
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${project}/notes.txt`, "New implementation notes\n");
        yield* fs.writeFileString(`${project}/notes.test.ts`, "const expected = 2;\n");
      }),
    );
    const thread = await t3.thread({ project, title: "Diff folds", messages: ["first"] });

    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Diff").tap();

    const fileToggle = (path: string, expanded: boolean) =>
      screen.getByRole("button", `${expanded ? "Collapse" : "Expand"} ${path}`, { exact: true });
    for (const path of ["notes.test.ts", "notes.txt"]) {
      // Open each file once to load its patch before testing the saved folds.
      await fileToggle(path, false).tap();
      await fileToggle(path, true).tap();
      await fileToggle(path, false).waitFor();
    }

    const filter = screen.getByRole("button", "Hide test files", { exact: true });
    await filter.tap();
    await fileToggle("notes.test.ts", false).waitFor({ state: "hidden" });
    await screen.getByRole("button", "Expand all files", { exact: true }).tap();
    await fileToggle("notes.txt", true).waitFor();
    await filter.tap();

    const testFile = screen.getByRole("button", /^(Collapse|Expand) notes\.test\.ts$/);
    await testFile.waitFor();
    await app.screenshot("test-file-shown-again");
    await expect(testFile).toHaveAttribute("aria-expanded", "false");
  },
);
