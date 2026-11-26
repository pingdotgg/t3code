/// <reference lib="dom" />
import type {
  EnvironmentSpeechStatus,
  GitPreparePullRequestThreadResult,
} from "@t3tools/contracts";
import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { environmentId, makeState, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingDictatedCheckout?: {
      readonly started: Promise<string>;
      readonly finish: () => void;
    };
  }
}

for (const checkoutSucceeds of [true, false])
  test(
    checkoutSucceeds
      ? "A detached dictated prompt waits for its pull request worktree"
      : "A failed checkout keeps a detached dictated prompt in its draft",
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

      await t3.thread({ project, title: "Other thread", messages: ["An earlier conversation"] });
      const environment = await runPromise(environmentId(app.baseUrl ?? ""));
      const transcribing = Promise.withResolvers<void>();
      const transcript = Promise.withResolvers<void>();
      const status: EnvironmentSpeechStatus = {
        supported: true,
        state: "ready",
        modelId: "scenario-speech",
        model: "Scenario Speech",
        size: 1,
        supportsStreaming: false,
        supportsTranslation: false,
        acceleration: "cpu",
        benchmarkTier: "cpu",
        modelUnloadTimeout: "never",
        gpuDevices: [],
      };
      await browser.route(/\/api\/voice\/status$/, (route) => route.fulfill({ json: status }));
      await browser.route(/\/api\/voice\/transcribe$/, async (route) => {
        transcribing.resolve();
        await transcript.promise;
        return route.fulfill({ json: { text: "using the new branch" } });
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
      await browser.addInitScript(
        ({ value, environmentId, checkoutSucceeds, project }) => {
          localStorage.setItem(
            "t3code:voice-audio-grant:v1",
            JSON.stringify({ id: "scenario", destination: { kind: "environment", environmentId } }),
          );
          Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
            value: async () => ({ getTracks: () => [] }),
          });
          window.AudioContext = class {
            audioWorklet = { addModule: async () => {} };
            createMediaStreamSource() {
              return { connect() {} };
            }
            resume = async () => {};
            close = async () => {};
          } as unknown as typeof AudioContext;
          window.AudioWorkletNode = class {
            port = {
              onmessage: undefined as
                | ((event: { data: Float32Array | "stopped" }) => void)
                | undefined,
              postMessage: (message: string) => {
                if (message === "start")
                  this.port.onmessage?.({ data: new Float32Array(1600).fill(0.2) });
                if (message === "stop") this.port.onmessage?.({ data: "stopped" });
              },
              close() {},
            };
            connect() {}
            disconnect() {}
          } as unknown as typeof AudioWorkletNode;
          const started = Promise.withResolvers<string>();
          const complete = Promise.withResolvers<void>();
          window.pendingDictatedCheckout = { started: started.promise, finish: complete.resolve };

          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            const request: {
              _tag: string;
              tag: string;
              id: string;
              payload: { threadId: string };
            } | null = typeof data === "string" ? JSON.parse(data) : null;
            if (request?._tag !== "Request" || request.tag !== "git.preparePullRequestThread") {
              return send.call(this, data);
            }

            started.resolve(request.payload.threadId);
            void complete.promise.then(() => {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    _tag: "Exit",
                    requestId: request.id,
                    exit: checkoutSucceeds
                      ? { _tag: "Success", value }
                      : {
                          _tag: "Failure",
                          cause: [
                            {
                              _tag: "Fail",
                              error: {
                                _tag: "GitManagerError",
                                operation: "preparePullRequestThread",
                                cwd: project,
                                detail: "Checkout failed",
                              },
                            },
                          ],
                        },
                  }),
                }),
              );
            });
          };
        },
        { value: prepared, environmentId: environment, checkoutSucceeds, project },
      );

      await t3.open("/new?pr=example/demo/42");
      await screen.getByRole("button", "Check out", { exact: true }).tap();
      const composer = screen.getByRole("textbox");
      const prompt = "Explain the pull request changes";
      await composer.fill(prompt);
      const threadId = await browser.evaluate(async () => {
        return (await window.pendingDictatedCheckout?.started) ?? "";
      });
      const draftPath = await browser.evaluate(() => window.location.pathname);
      await screen.getByRole("button", "Start voice input", { exact: true }).tap();
      await screen.getByRole("button", "Finish voice input", { exact: true }).waitFor();
      await screen.getByRole("button", "Submit message", { exact: true }).tap();
      await transcribing.promise;
      await screen.getByRole("button", /^Other thread(?:,|$)/).tap();
      await screen.getByText("An earlier conversation", { exact: true }).waitFor();
      if (checkoutSucceeds) transcript.resolve();
      const transcriptSaved = () =>
        expect
          .poll(() =>
            browser.evaluate(
              () =>
                localStorage
                  .getItem("t3code:composer-drafts:v1")
                  ?.includes("using the new branch") ?? false,
            ),
          )
          .toBe(true);
      if (checkoutSucceeds) await transcriptSaved();
      await browser.evaluate(() => {
        window.pendingDictatedCheckout?.finish();
        return null;
      });
      if (!checkoutSucceeds) {
        await screen
          .getByText("Could not prepare the pull request checkout", { exact: true })
          .waitFor();
        transcript.resolve();
        await transcriptSaved();
        await t3.open(draftPath);
        await expect(screen.getByRole("textbox")).toContainText("using the new branch");
        return;
      }
      await screen.getByText("Checked out", { exact: true }).waitFor();
      await browser
        .locator('[data-testid="sidebar-row-card"]')
        .filter({ hasText: prompt })
        .waitFor();
      await t3.open({ threadId });

      await browser
        .locator('[data-message-role="user"]')
        .filter({ hasText: "using the new branch" })
        .waitFor();
      const { cli } = makeState(T3_HOME);
      const { stdout } = await runPromise(cli(["thread", "show", threadId, "--json"]));
      const persisted: unknown = JSON.parse(stdout);
      await expect(persisted).toMatchObject({
        thread: { branch: "review-42", worktreePath: worktree },
      });
    },
  );
