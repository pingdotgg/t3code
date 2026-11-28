/// <reference lib="dom" />
import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    failedPrCheckout?: {
      readonly started: Promise<void>;
      readonly finish: () => void;
    };
  }
}

test(
  "A prompt submitted during a failed pull request checkout stays in the composer",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "local" }),
    });
    await runPromise(
      run("git", ["remote", "add", "origin", "https://github.com/example/demo.git"], {
        cwd: project,
      }),
    );

    await browser.addInitScript(() => {
      const started = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<void>();
      window.failedPrCheckout = { started: started.promise, finish: failure.resolve };

      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          tag: string;
          id: string;
          payload: { cwd: string };
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request" || request.tag !== "git.preparePullRequestThread") {
          return send.call(this, data);
        }

        started.resolve();
        void failure.promise.then(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [
                    {
                      _tag: "Fail",
                      error: {
                        _tag: "GitManagerError",
                        cwd: request.payload.cwd,
                        operation: "preparePullRequestThread",
                        detail: "The pull request branch could not be fetched.",
                      },
                    },
                  ],
                },
              }),
            }),
          );
        });
      };
    });

    await t3.open("/new?pr=example/demo/42");
    await screen.getByRole("button", "Check out", { exact: true }).tap();
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    await browser.evaluate(async () => {
      await window.failedPrCheckout?.started;
      return null;
    });
    await composer.press("Enter");
    await browser.evaluate(() => {
      window.failedPrCheckout?.finish();
      return null;
    });
    await screen
      .getByText("Could not prepare the pull request checkout", { exact: true })
      .waitFor();
    await app.screenshot("failed-checkout");
    await expect(composer).toContainText(prompt, { timeout: 3000 });
  },
);
