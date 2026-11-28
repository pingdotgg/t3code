/// <reference lib="dom" />
import type {
  EnvironmentSpeechStatus,
  GitPreparePullRequestThreadResult,
} from "@t3tools/contracts";
import { expect } from "e2e";

import { run } from "./shell.ts";
import { environmentId, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    dictatedPrCheckout?: {
      readonly started: Promise<string>;
      readonly finish: () => void;
    };
  }
}

test(
  "A dictated prompt sent after switching threads uses the prepared pull request branch",
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
      ({ value, environmentId }) => {
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
        window.dictatedPrCheckout = { started: started.promise, finish: complete.resolve };

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
                  exit: { _tag: "Success", value },
                }),
              }),
            );
          });
        };
      },
      { value: prepared, environmentId: environment },
    );

    await t3.open("/new?pr=example/demo/42");
    await screen.getByRole("button", "Check out", { exact: true }).tap();
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    const threadId = await browser.evaluate(async () => {
      return (await window.dictatedPrCheckout?.started) ?? "";
    });
    await screen.getByRole("button", "Start voice input", { exact: true }).tap();
    await screen.getByRole("button", "Finish voice input", { exact: true }).waitFor();
    await screen.getByRole("button", "Submit message", { exact: true }).tap();
    await transcribing.promise;
    await screen.getByRole("button", /^Other thread(?:,|$)/).tap();
    await screen.getByText("An earlier conversation", { exact: true }).waitFor();
    await browser.evaluate(() => {
      window.dictatedPrCheckout?.finish();
      return null;
    });
    await screen.getByText("Checked out", { exact: true }).waitFor();
    transcript.resolve();
    await browser.locator('[data-testid="sidebar-row-card"]').filter({ hasText: prompt }).waitFor();
    await t3.open({ threadId });

    await browser
      .locator('[data-message-role="user"]')
      .filter({ hasText: "using the new branch" })
      .waitFor();
    const branch = browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first();
    await app.screenshot("dictated-message-workspace");
    await expect(branch).toContainText("review-42", { timeout: 3000 });
  },
);
