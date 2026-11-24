/// <reference lib="dom" />
import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    voiceSetupDevices: {
      holdNext: () => void;
      held: Promise<void>;
      replaceMicrophone: () => void;
      releaseOld: () => Promise<void>;
    };
  }
}

test(
  "Voice setup keeps the current microphone after an older refresh finishes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Voice notes", messages: ["first"] });

    const model = {
      id: "scenario-speech",
      name: "Scenario speech model",
      description: "",
      size: 1_048_576,
      languages: ["en", "fr", "de"],
      accuracy: 1,
      speed: 1,
      recommended: true,
      supportsStreaming: false,
      supportsLanguageDetection: true,
      supportsTranslation: false,
      active: false,
      state: "downloadable",
    } satisfies EnvironmentSpeechModel;
    let installed = false;
    await browser.route(/\/api\/voice\/status$/, (route) => {
      const status = {
        supported: true,
        state: installed ? "ready" : "missing-model",
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
      return route.fulfill({ json: status });
    });
    await browser.route(/\/api\/voice\/models(?:\?|$)/, (route) =>
      route.fulfill({
        json: { models: [installed ? { ...model, active: true, state: "installed" } : model] },
      }),
    );
    await browser.route(/\/api\/voice\/models\/download$/, (route) => {
      installed = true;
      return route.fulfill({
        json: { models: [{ ...model, active: true, state: "installed" }] },
      });
    });

    await browser.addInitScript(() => {
      const oldMicrophone = { kind: "audioinput", deviceId: "desk", label: "Desk microphone" };
      const newMicrophone = { kind: "audioinput", deviceId: "usb", label: "USB microphone" };
      const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
      const { promise: old, resolve: release } =
        Promise.withResolvers<Array<typeof oldMicrophone>>();
      let holdNext = false;
      let current = oldMicrophone;
      const media = navigator.mediaDevices;
      Object.defineProperty(media, "enumerateDevices", {
        configurable: true,
        value: () => {
          if (!holdNext) return Promise.resolve([current]);
          holdNext = false;
          markHeld();
          return old;
        },
      });
      window.voiceSetupDevices = {
        holdNext: () => {
          holdNext = true;
        },
        held,
        replaceMicrophone: () => {
          current = newMicrophone;
          media.dispatchEvent(new Event("devicechange"));
        },
        releaseOld: async () => {
          release([oldMicrophone]);
          // Let enumeration and its React update settle before inspecting the picker.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
      };
    });

    await t3.open(thread);
    const threadPath = new URL(await browser.url()).pathname;
    const voice = screen.getByRole("button", "Start voice input");
    await voice.tap();
    const destination = screen.getByRole("combobox", "Transcribe with");
    await destination.tap();
    // The only paired environment is the first choice after Off.
    await screen.getByRole("option").nth(1).tap();
    await app.open(threadPath);
    await voice.tap();

    const download = screen.getByRole("button", "Download model", { exact: true });
    await download.waitFor();
    await browser.evaluate(() => {
      window.voiceSetupDevices.holdNext();
      return null;
    });
    await download.tap();
    await screen.getByText("Voice input is ready", { exact: true }).waitFor();
    await browser.evaluate(async () => {
      await window.voiceSetupDevices.held;
      window.voiceSetupDevices.replaceMicrophone();
      return null;
    });
    await screen.getByRole("combobox", "Microphone", { exact: true }).tap();
    const connected = screen.getByRole("option", "USB microphone", { exact: true });
    await connected.waitFor();

    await browser.evaluate(async () => {
      await window.voiceSetupDevices.releaseOld();
      return null;
    });
    await app.screenshot("microphones-after-both-refreshes");
    const labels = await browser.evaluate(() =>
      Array.from(
        document.querySelectorAll('[role="listbox"] [role="option"]'),
        (option) => option.textContent?.trim() ?? "",
      ),
    );
    expect(labels, "The microphone picker lists only the current devices").toEqual([
      "System default",
      "USB microphone",
    ]);
  },
);
