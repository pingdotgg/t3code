/// <reference lib="dom" />
import type { GitResolvePullRequestResult } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A failed local checkout does not show its error on another pull request",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.setViewport({ width: 1280, height: 800 });
    await browser.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          id: string;
          tag: string;
          payload: { cwd: string; reference: string };
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request") return send.call(this, data);
        const reply = (exit: unknown) =>
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
              }),
            ),
          );
        if (request.tag === "git.resolvePullRequest") {
          const number = Number(request.payload.reference.replace(/^#/, ""));
          const value: GitResolvePullRequestResult = {
            pullRequest: {
              number,
              title: number === 42 ? "Update the release notes" : "Fix the status badge",
              url: `https://github.com/example/demo/pull/${number}`,
              baseBranch: "main",
              headBranch: `change-${number}`,
              state: "open",
            },
          };
          reply({ _tag: "Success", value });
          return;
        }
        if (request.tag === "git.preparePullRequestThread") {
          reply({
            _tag: "Failure",
            cause: [
              {
                _tag: "Fail",
                error: {
                  _tag: "GitManagerError",
                  operation: "preparePullRequestThread",
                  cwd: request.payload.cwd,
                  detail:
                    "This repository has uncommitted changes. Commit or stash them before checking out pull request #42 here, or check it out in its own folder.",
                },
              },
            ],
          });
          return;
        }
        return send.call(this, data);
      };
    });

    await t3.open("/");
    await browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first()
      .click();
    await screen.getByPlaceholder("Search refs...").fill("#42");
    const checkoutLabel = /Checkout (?:pull|change) request/i;
    await screen.getByRole("option", checkoutLabel).tap();

    const dialog = screen.getByRole("dialog", checkoutLabel);
    await dialog.getByText("Update the release notes", { exact: true }).waitFor();
    await dialog.getByRole("button", "Local", { exact: true }).tap();
    const previousError = dialog.getByText(/before checking out pull request #42 here/);
    await previousError.waitFor();
    await dialog.getByRole("textbox").fill("#43");
    await dialog.getByText("Fix the status badge", { exact: true }).waitFor();
    await app.screenshot("second-pull-request");
    expect(
      await previousError.isVisible(),
      "The second pull request does not display the first checkout error",
    ).toBe(false);
  },
);
