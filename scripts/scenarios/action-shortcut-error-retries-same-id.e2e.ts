/// <reference lib="dom" />
import { WS_METHODS, type ServerSettings } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

function matchingActions(settings: ServerSettings) {
  return Object.values(settings.projectSettingsOverrides)
    .flatMap((entry) => entry.defaultProjectScripts ?? [])
    .filter((script) => script.name === "Run smoke checks");
}

const readConfig = (origin: string) =>
  runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        return yield* client[WS_METHODS.serverGetConfig]({});
      }),
    ),
  );

test(
  "Retrying a shortcut file error saves the shortcut for the original action",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project work", messages: ["Start"] });
    const origin = app.baseUrl ?? "";
    const { keybindingsConfigPath } = await readConfig(origin);
    const original = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(keybindingsConfigPath)),
    );
    const writeKeybindings = (contents: string) =>
      runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(keybindingsConfigPath, contents),
        ),
      );

    await browser.setViewport({ width: 1920, height: 1000 });
    await t3.open(thread);
    await screen.getByRole("button", "Add project script", { exact: true }).tap();
    await browser.locator("#script-name").fill("Run smoke checks");
    await browser.locator("#script-command").fill("echo checks");
    await browser.locator("#script-keybinding").press("Control+Shift+7");
    const editor = browser.locator('[data-slot="dialog-popup"][data-open]');
    const save = editor.getByRole("button", "Save action", { exact: true });

    let firstSettings;
    try {
      await writeKeybindings("{invalid JSON");
      await save.tap();
      await editor.getByText(/Unable to parse keybindings config/).waitFor();
      firstSettings = (await readConfig(origin)).settings;
    } finally {
      await writeKeybindings(original);
    }

    const firstActions = matchingActions(firstSettings);
    expect(firstActions).toHaveLength(1);
    const actionId = firstActions[0]!.id;
    await save.tap();
    await editor.waitFor({ state: "hidden" });
    await screen.getByRole("button", "Script actions", { exact: true }).tap();
    await screen
      .getByRole("menuitem", /^Run smoke checks/)
      .first()
      .waitFor();
    await app.screenshot("actions-after-retrying-save");

    const config = await readConfig(origin);
    expect(matchingActions(config.settings).map((script) => script.id)).toEqual([actionId]);
    expect(
      config.keybindings.some(
        ({ command, shortcut }) =>
          command === `script.${actionId}.run` &&
          shortcut.key === "7" &&
          shortcut.shiftKey &&
          shortcut.modKey,
      ),
    ).toBe(true);
  },
);
