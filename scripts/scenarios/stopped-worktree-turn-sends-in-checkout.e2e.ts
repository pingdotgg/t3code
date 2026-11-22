import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A worktree thread stopped mid-turn and moved to the project checkout runs its next message",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    // The question recording waits for an answer, so the turn is running in its new worktree.
    const started = await runPromise(
      makeState(T3_HOME).cli(
        [
          "thread",
          "start",
          project,
          "Ask me something",
          "--worktree",
          "main",
          "--provider",
          "devReplay",
          "--model",
          "question",
          "--wait",
          "--json",
        ],
        [2],
      ),
    );
    await t3.open(JSON.parse(started.stdout) as { threadId: string });

    const stop = screen.getByRole("button", "Stop generation");
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await stop.tap();
    await expect(stop).toBeHidden();

    await browser.locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible').click();
    await screen.getByRole("option", /^main\b/).tap();

    await screen.getByRole("textbox").fill("Once more");
    await screen.getByRole("textbox").press("Enter");
    await expect(screen.getByText("Once more").first()).toBeVisible();
    await app.screenshot("sent-in-checkout");
    await expect(stop).toBeVisible({ timeout: 60_000 });
  },
);
