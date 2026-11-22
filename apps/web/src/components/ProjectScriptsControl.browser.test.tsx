import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import ProjectScriptsControl, { type ProjectScriptActionResult } from "./ProjectScriptsControl";

it.each(["edit", "dismiss", "newer import fails first"] as const)(
  "keeps a failed import from replacing a newer action after %s",
  async (nextAction) => {
    const older = Promise.withResolvers<ProjectScriptActionResult>();
    const newer = Promise.withResolvers<ProjectScriptActionResult>();
    await using screen = await render(
      <ProjectScriptsControl
        environmentId={EnvironmentId.make("test")}
        displayMode="panel"
        scripts={[
          {
            id: "local-check",
            name: "Local check",
            command: "echo local",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ]}
        fileScripts={[
          { name: "Shared build", command: "echo build" },
          { name: "Shared lint", command: "echo lint" },
        ]}
        onRunScript={() => {}}
        onAddScript={({ name }) => (name === "Shared build" ? older.promise : newer.promise)}
        onUpdateScript={async () => AsyncResult.success(undefined)}
        onDeleteScript={async () => AsyncResult.success(undefined)}
      />,
    );

    const actions = screen.getByRole("button", { name: "Script actions" });
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    const failure = AsyncResult.failure<void, unknown>(
      Cause.fail(new Error("Settings write failed")),
    );

    await actions.click();
    await page.getByRole("menuitem", { name: /Shared build/ }).click();
    await actions.click();

    switch (nextAction) {
      case "edit":
        await page.getByRole("button", { name: "Edit Local check" }).click();
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Local check");
        break;
      case "dismiss":
        await page.getByRole("menuitem", { name: "Add project script" }).click();
        await expect.element(dialog).toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect.element(dialog).not.toBeInTheDocument();
        await act(async () => older.resolve(failure));
        expect(dialog.query() === null).toBe(true);
        break;
      case "newer import fails first":
        await page.getByRole("menuitem", { name: /Shared lint/ }).click();
        await act(async () => newer.resolve(failure));
        await act(async () => older.resolve(failure));
        expect(name.query()).toHaveProperty("value", "Shared lint");
        break;
    }
  },
);
