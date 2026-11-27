/// <reference lib="dom" />
import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentSpeechStatus } from "@t3tools/contracts";
import { expect } from "e2e";

import { run } from "./shell.ts";
import { environmentId, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pendingDictatedCheckout?: {
      readonly started: Promise<string>;
      readonly finish: () => void;
      readonly launches: string[];
    };
  }
}

test(
  "A dictated prompt stays unsent in the open draft when its pull request checkout fails first",
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
    await browser.addInitScript(
      ({ environmentId, project, launchMethod }) => {
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
        let draftThreadId: string | undefined;
        const launches: string[] = [];
        window.pendingDictatedCheckout = {
          started: started.promise,
          launches,
          finish: complete.resolve,
        };

        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          const request: {
            _tag: string;
            tag: string;
            id: string;
            payload: { threadId: string };
          } | null = typeof data === "string" ? JSON.parse(data) : null;
          if (
            request?._tag === "Request" &&
            request.tag === launchMethod &&
            request.payload.threadId === draftThreadId
          ) {
            launches.push(request.payload.threadId);
          }
          if (request?._tag !== "Request" || request.tag !== "git.preparePullRequestThread") {
            return send.call(this, data);
          }

          draftThreadId = request.payload.threadId;
          started.resolve(draftThreadId);
          void complete.promise.then(() => {
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
      {
        environmentId: environment,
        project,
        launchMethod: ORCHESTRATION_V2_WS_METHODS.launchThread,
      },
    );

    await t3.open("/new?pr=example/demo/42");
    await screen.getByRole("button", "Check out", { exact: true }).tap();
    const composer = screen.getByRole("textbox");
    const prompt = "Explain the pull request changes";
    await composer.fill(prompt);
    await browser.evaluate(async () => {
      await window.pendingDictatedCheckout?.started;
      return null;
    });
    await screen.getByRole("button", "Start voice input", { exact: true }).tap();
    await screen.getByRole("button", "Finish voice input", { exact: true }).waitFor();
    await screen.getByRole("button", "Submit message", { exact: true }).tap();
    await transcribing.promise;
    await browser.evaluate(() => {
      window.pendingDictatedCheckout?.finish();
      return null;
    });
    await screen
      .getByText("Could not prepare the pull request checkout", { exact: true })
      .waitFor();
    transcript.resolve();
    await expect(screen.getByText("Message not sent", { exact: true })).toBeVisible();
    await app.screenshot("dictated-prompt-after-failed-checkout");
    const launches = await browser.evaluate(() => window.pendingDictatedCheckout?.launches ?? []);
    await expect(launches).toEqual([]);
    await expect(composer).toContainText("using the new branch");
  },
);
