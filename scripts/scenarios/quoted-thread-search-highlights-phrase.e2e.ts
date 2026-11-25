import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Quoted thread search selects the complete phrase across rendered line breaks",
  WEB,
  async ({ t3, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Weekly notes", messages: ["Start"] });
    await t3.open(thread);

    const message = [
      "soft\nbreak",
      "hard  \nbreak",
      ["```text", "canary", `${" ".repeat(17)}migration`, "canary", "    migration", "```"].join(
        "\n",
      ),
    ].join("\n\n");
    const composer = screen.getByRole("textbox", "Message Weekly notes");
    await composer.fill(message);
    await composer.press("Enter");
    await screen.getByText("second fixture turn complete").waitFor();

    const query = screen.getByRole("combobox", "Search threads");
    const find = browser.locator('[data-thread-find-bar] [role="search"]');
    for (const phrase of ["canary migration", "soft break", "hard break"]) {
      await query.fill(`"${phrase}"`);
      await screen.getByRole("option").filter({ hasText: phrase }).tap();
      await expect(find).toContainText("1/1");
      const active = await browser.evaluate(() =>
        [...(CSS.highlights.get("t3-thread-find-active") ?? [])].flatMap((range) =>
          range instanceof Range &&
          range.startContainer.parentElement?.closest("[data-user-message-body]")
            ? [range.toString()]
            : [],
        ),
      );
      expect(active.map((text) => text.replace(/\s/g, ""))).toEqual([phrase.replace(" ", "")]);
      if (phrase === "canary migration") expect(active).toEqual(["canary\n    migration"]);
      await screen.getByRole("button", "Close find").tap();
    }
  },
);
