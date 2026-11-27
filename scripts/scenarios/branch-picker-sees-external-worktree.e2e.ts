/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "Reopening the branch picker shows a worktree created outside T3 Code",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const git = (...args: string[]) => runPromise(run("git", args, { cwd: project }));
    await git("branch", "feature");
    await browser.setViewport({ width: 1280, height: 800 });

    // Wait for the real server's first forced ref listing to complete before changing Git.
    await browser.addInitScript(() => {
      const refreshRequests = new Set<string>();
      const watched = new WeakSet<WebSocket>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (request?.tag === "vcs.listRefs" && request.payload?.refresh === true) {
              refreshRequests.add(String(request.id));
            }
          }
        }
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            for (const response of [JSON.parse(event.data)].flat()) {
              if (
                response?._tag === "Exit" &&
                response.exit?._tag === "Success" &&
                refreshRequests.has(String(response.requestId))
              ) {
                document.documentElement.dataset.refRefresh = "done";
              }
            }
          });
        }
        return send.call(this, data);
      };
    });

    await t3.open("/");
    const branchPicker = browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first();
    await branchPicker.click();
    await screen.getByRole("option", /^feature\b/).waitFor();
    await browser.locator('html[data-ref-refresh="done"]').waitFor({ state: "attached" });
    await browser.keyboard.press("Escape");
    // The server coalesces forced snapshot reads for five seconds.
    await runPromise(Effect.sleep("6 seconds"));

    await git("worktree", "add", "../other-checkout", "feature");
    try {
      await branchPicker.click();
      const feature = screen.getByRole("option", /^feature\b/);
      await feature.waitFor();
      await app.screenshot("branch-picker-after-external-worktree");
      await expect(feature).toContainText("worktree");
    } finally {
      await git("worktree", "remove", "../other-checkout");
    }
  },
);
