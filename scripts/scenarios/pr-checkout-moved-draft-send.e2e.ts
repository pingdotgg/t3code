/// <reference lib="dom" />
import type { GitPreparePullRequestThreadResult } from "@t3tools/contracts";
import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    checkoutDuringSend?: {
      readonly started: Promise<void>;
      readonly finish: () => void;
    };
  }
}

test(
  "A draft moved during checkout can be reviewed and sent again",
  WEB,
  async ({ t3, browser, screen }) => {
    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }),
    });
    await runPromise(
      run("git", ["remote", "add", "origin", "https://github.com/example/demo.git"], {
        cwd: project,
      }),
    );

    await t3.project("other-project", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }),
    });
    const worktree = `${project}-review`;
    await runPromise(
      run("git", ["worktree", "add", "--quiet", "-b", "review-42", worktree], { cwd: project }),
    );

    const prepared: GitPreparePullRequestThreadResult = {
      branch: "review-42",
      worktreePath: worktree,
      isOnPullRequestHead: true,
      pullRequest: {
        number: 42,
        title: "Review branch",
        url: "https://github.com/example/demo/pull/42",
        headBranch: "review-42",
        baseBranch: "main",
        state: "open",
      },
    };
    await browser.addInitScript((value) => {
      const started = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      window.checkoutDuringSend = { started: started.promise, finish: complete.resolve };

      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          tag: string;
          id: string;
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request" || request.tag !== "git.preparePullRequestThread") {
          return send.call(this, data);
        }

        started.resolve();
        void complete.promise.then(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Success", value },
              }),
            }),
          );
        });
      };
    }, prepared);

    await t3.open("/new?pr=example/demo/42");
    await screen.getByRole("button", "Check out", { exact: true }).tap();
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    await browser.evaluate(async () => {
      await window.checkoutDuringSend?.started;
      return null;
    });
    await composer.press("Enter");
    const picker = browser.locator("[data-draft-project-trigger]");
    await picker.tap();
    await screen.getByRole("option", "other-project", { exact: true }).tap();
    await picker.filter({ hasText: "other-project" }).waitFor();
    await expect(
      screen.getByText("Draft changed while preparing this message. Review it and send again."),
    ).toBeVisible();
    await expect(composer).toHaveText(prompt);

    await composer.press("Enter");
    await expect(screen.getByText(prompt, { exact: true })).toBeVisible();
    await expect(composer).toHaveText("");
    await browser.evaluate(() => {
      window.checkoutDuringSend?.finish();
      return null;
    });
    await expect(
      screen.getByText("Checkout finished without attaching to the draft"),
    ).toBeVisible();
  },
);
