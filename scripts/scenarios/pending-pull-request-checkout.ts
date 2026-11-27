/// <reference lib="dom" />
import type { GitPreparePullRequestThreadResult } from "@t3tools/contracts";

import { run } from "./shell.ts";
import { runPromise, test } from "./t3.ts";

declare global {
  interface Window {
    checkoutDuringSend?: {
      readonly started: Promise<void>;
      readonly finish: () => void;
    };
  }
}

export const testWithPendingCheckout = test.extend<{ finishCheckout: () => Promise<void> }>({
  finishCheckout: async ({ t3, browser, screen }, use) => {
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
    await browser.evaluate(async () => {
      await window.checkoutDuringSend?.started;
      return null;
    });
    await use(async () => {
      await browser.evaluate(() => {
        window.checkoutDuringSend?.finish();
        return null;
      });
    });
  },
});
