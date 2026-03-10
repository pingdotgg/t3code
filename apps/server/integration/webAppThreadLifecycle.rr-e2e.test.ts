import { describe, expect, it } from "vitest";

import {
  chromiumInstalled,
  runReplayScenario,
  shouldRunReplayE2E,
} from "./webAppReplayHarness/testSupport/runReplayScenario.ts";
import {
  completeTurn,
  createReadyThread,
  sendPromptInNewThread,
} from "./webAppReplayHarness/testSupport/threadScenarioHelpers.ts";

const RR_E2E_TIMEOUT_MS = 90_000;

describe("web app thread lifecycle rr e2e", () => {
  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "shows bootstrap state for a new workspace",
    async () => {
      await runReplayScenario(import.meta.url, "bootstrap", async (app) => {
        await app.waitForBootstrap();
      });
    },
    RR_E2E_TIMEOUT_MS,
  );

  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "creates a thread and keeps URL stable after first reply",
    async () => {
      await runReplayScenario(import.meta.url, "happyPath", async (app) => {
        await createReadyThread(app);
        const threadPath = app.currentPath();

        await completeTurn(
          app,
          "Explain how the replay harness works.",
          "Replay harness response for the first message.",
        );

        expect(app.currentPath()).toBe(threadPath);
      });
    },
    RR_E2E_TIMEOUT_MS,
  );

  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "renders user prompt and assistant response in transcript",
    async () => {
      await runReplayScenario(import.meta.url, "happyPath", async (app) => {
        const prompt = "Explain how the replay harness works.";
        await sendPromptInNewThread(
          app,
          prompt,
          "Replay harness response for the first message.",
        );

        await app.waitForTranscriptText(prompt);
      });
    },
    RR_E2E_TIMEOUT_MS,
  );

  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "supports multiple turns in one thread",
    async () => {
      await runReplayScenario(import.meta.url, "twoTurns", async (app) => {
        await createReadyThread(app);

        await completeTurn(app, "First question", "First assistant reply.");

        await completeTurn(app, "Second question", "Second assistant reply.");
      });
    },
    RR_E2E_TIMEOUT_MS,
  );

  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "shows codex provider unavailable state",
    async () => {
      await runReplayScenario(import.meta.url, "providerOffline", async (app) => {
        await app.waitForBootstrap();
        await app.waitForProviderUnavailable("Codex unavailable");
      });
    },
    RR_E2E_TIMEOUT_MS,
  );

  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "keeps composer editable after a completed turn",
    async () => {
      await runReplayScenario(import.meta.url, "happyPath", async (app) => {
        await sendPromptInNewThread(
          app,
          "Explain how the replay harness works.",
          "Replay harness response for the first message.",
        );

        await app.typeIntoComposer("Draft after completion");
        const text = await app.readComposerText();
        expect(text).toContain("Draft after completion");
      });
    },
    RR_E2E_TIMEOUT_MS,
  );
});
