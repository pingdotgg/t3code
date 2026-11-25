/// <reference lib="dom" />
import { expect } from "e2e";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A test-only Changes diff explains how to show its files",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const path = "math.test.ts";
    const project = await t3.project("demo", { [path]: "const expected = 1;\n" });
    const git = (...args: string[]) => runPromise(run("git", args, { cwd: project }));
    await git("switch", "-c", "test-only");
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(`${project}/${path}`, "const expected = 2;\n"),
      ),
    );
    await git(
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@example.invalid",
      "commit",
      "-m",
      "Update test",
      "--",
      path,
    );
    const thread = await t3.thread({ project, title: "Test-only changes", messages: ["first"] });

    await browser.addInitScript(() => localStorage.setItem("t3code.diffHideTestFiles", "true"));
    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Diff", { exact: true }).tap();

    const filter = screen.getByRole("button", "Hide test files", { exact: true });
    await expect(filter).toHaveAttribute("aria-pressed", "true");
    await app.screenshot("test-only-changes-filtered");
    await expect(screen.getByText("1 test file hidden", { exact: true })).toBeVisible();
    await screen.getByRole("button", "Show test files", { exact: true }).tap();
    await expect(filter).toHaveAttribute("aria-pressed", "false");
    await expect(screen.getByRole("button", /^(Collapse|Expand) math\.test\.ts$/)).toBeVisible();
  },
);
