import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Voice settings keeps progress below 100 percent while the final write is pending",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    // The download stream reports received bytes before the file sink finishes writing them.
    const model = {
      id: "scenario-speech",
      name: "Scenario speech model",
      description: "",
      size: 1_048_576,
      downloaded: 1_048_576,
      languages: ["en"],
      accuracy: 1,
      speed: 1,
      recommended: true,
      supportsStreaming: false,
      supportsLanguageDetection: false,
      supportsTranslation: false,
      active: false,
      state: "downloading",
    } satisfies EnvironmentSpeechModel;
    const status = {
      supported: true,
      state: "missing-model",
      modelId: model.id,
      model: model.name,
      size: model.size,
      supportsStreaming: false,
      supportsTranslation: false,
      acceleration: "cpu",
      benchmarkTier: "cpu",
      modelUnloadTimeout: "never",
      gpuDevices: [],
    } satisfies EnvironmentSpeechStatus;
    await browser.route(/\/api\/voice\/status$/, (route) => route.fulfill({ json: status }));
    await browser.route(/\/api\/voice\/models(?:\?|$)/, (route) =>
      route.fulfill({ json: { models: [model] } }),
    );

    await t3.open("/settings/voice");
    await screen.getByRole("combobox", "Transcribe with").tap();
    await screen.getByRole("option").nth(1).tap();
    const progress = screen.getByText(/^\d+% downloaded$/);
    await progress.waitFor();
    await app.screenshot("final-write-pending");
    await expect(progress).toHaveText("99% downloaded");
  },
);
