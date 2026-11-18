import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A Latin letter inside a new project name stays in the same folder name word",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project setup", messages: ["Start"] });
    await t3.open(thread);

    await screen.getByRole("button", "Add project").tap();
    await screen.getByText("New project", { exact: true }).tap();
    await screen.getByRole("combobox").fill("Aŉa");
    const path = screen.getByText(/^Creates /);
    await path.waitFor();

    await app.screenshot("generated-project-folder");
    await expect(path).toHaveText(/[/\\]ana$/);
  },
);
