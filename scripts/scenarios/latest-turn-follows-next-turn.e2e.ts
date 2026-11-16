import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "Latest turn in the Diff panel moves to the next completed turn",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", { "notes.txt": "first line\n" });
    const thread = await t3.thread({ project, title: "Latest turn", messages: ["first"] });

    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Diff").tap();
    await screen.getByRole("button", "Diff scope: Changes").tap();
    await screen.getByRole("menuitemradio", "Latest turn").tap();
    await expect(screen.getByRole("button", "Diff scope: Latest turn")).toBeVisible();

    // The replay agent edits no files, so the next turn's change is written here.
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${project}/notes.txt`, "first line\nsecond turn line\n");
      }),
    );
    const { cli } = makeState(T3_HOME);
    await runPromise(cli(["thread", "send", thread.threadId, "second", "--wait", "--json"]));
    await expect(screen.getByText("1 changed file").first()).toBeVisible();
    await expect(screen.getByText("Loading checkpoint diff...")).toBeHidden();
    await expect(screen.getByText("Loading code...")).toBeHidden();
    await app.screenshot("after-next-turn");
    await expect(screen.getByRole("button", "Diff scope: Latest turn")).toBeVisible();
  },
);
