import { expect } from "e2e";

import { makeState, readEditorText, runPromise, test, WEB } from "./t3.ts";

const NOTE = "userdata/themes/nightfall.json/notes.txt";
const BODY = "Notes for the original Nightfall palette";

test(
  "Publishing a theme preserves files in an existing directory under the same name",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("theme-workspace", {
      [NOTE]: BODY,
      "nightfall.json": JSON.stringify({
        name: "Nightfall",
        appearance: "dark",
        canvas: "#1a1b26",
        accent: "#7aa2f7",
      }),
    });
    const thread = await t3.thread({
      project,
      title: "Theme notes",
      messages: [`See :codex-file-citation{path="${NOTE}" line_range_start="1"}`],
    });
    const { cli } = makeState(project);
    const { exitCode, stdout, stderr } = await runPromise(
      cli(["theme", "set", `${project}/nightfall.json`], [0, 1]),
    );
    if (exitCode === 1) {
      const output = `${stdout}\n${stderr}`.trim();
      if (
        !output.includes(
          'nightfall.json is a directory, so the theme cannot be published as "nightfall"',
        )
      ) {
        throw new Error(
          `Theme publish failed before the scenario could check the directory: ${output}`,
        );
      }
    }

    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^notes\.txt/).tap();

    try {
      await expect.poll(() => readEditorText(browser)).toContain(BODY);
    } finally {
      await app.screenshot("open-original-theme-notes");
    }
  },
);
