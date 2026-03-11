import fs from "node:fs";

import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";

import { createHarness } from "./harness.ts";

const shouldRunE2E = process.env.T3CODE_E2E === "1";
const chromiumInstalled = fs.existsSync(chromium.executablePath());
const STEP_TIMEOUT_MS = 10_000;

async function runScenario(fixtureName: string, run: (page: Page) => Promise<void>): Promise<void> {
  const harness = await createHarness(import.meta.url, { fixtureName });
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await harness.openPage(browser, {
    viewport: { width: 1440, height: 1024 },
  });

  try {
    await page.goto(harness.appUrl, { waitUntil: "domcontentloaded" });
    await run(page);
  } finally {
    await context.close();
    await browser.close();
    await harness.dispose();
  }
}

const transcript = (page: Page) => page.locator('[data-testid="chat-transcript"]');
const composer = (page: Page) => page.locator('[data-testid="chat-composer-editor"]');
const createThreadBtn = (page: Page) =>
  page.locator('[data-testid="sidebar-create-thread-button"]');
const providerBanner = (page: Page) =>
  page.locator('[data-testid="chat-provider-health-banner"]');

async function waitForBootstrap(page: Page): Promise<void> {
  await createThreadBtn(page).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-testid="chat-empty-state"]').waitFor({
    state: "visible",
    timeout: STEP_TIMEOUT_MS,
  });
}

async function createThread(page: Page): Promise<void> {
  const bootstrapPath = new URL(page.url()).pathname;
  await createThreadBtn(page).click();
  await page.waitForURL((url) => new URL(String(url)).pathname !== bootstrapPath, {
    timeout: STEP_TIMEOUT_MS,
  });
}

async function sendMessage(page: Page, prompt: string): Promise<void> {
  await composer(page).click();
  await page.keyboard.insertText(prompt);
  await page.locator('[data-testid="chat-send-button"]').click();
}

function userMessage(page: Page, text: string) {
  return transcript(page).locator('[data-message-role="user"]', { hasText: text });
}

function assistantMessage(page: Page, text: string) {
  return transcript(page).locator('[data-message-role="assistant"]', { hasText: text });
}

describe("thread rr e2e", () => {
  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "shows bootstrap state for a new workspace",
    async () => {
      await runScenario("bootstrap", async (page) => {
        await waitForBootstrap(page);
      });
    },
    30_000,
  );

  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "creates a thread and keeps URL stable after first reply",
    async () => {
      await runScenario("happyPath", async (page) => {
        await waitForBootstrap(page);
        await createThread(page);
        const threadPath = new URL(page.url()).pathname;

        await sendMessage(page, "Explain how this harness works.");
        await assistantMessage(page, "Harness response for the first message.").waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });

        expect(new URL(page.url()).pathname).toBe(threadPath);
      });
    },
    30_000,
  );

  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "renders user prompt and assistant response in transcript",
    async () => {
      await runScenario("happyPath", async (page) => {
        const prompt = "Explain how this harness works.";
        await waitForBootstrap(page);
        await createThread(page);
        await sendMessage(page, prompt);

        await userMessage(page, prompt).waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });
        await assistantMessage(page, "Harness response for the first message.").waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });
      });
    },
    30_000,
  );

  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "supports multiple turns in one thread",
    async () => {
      await runScenario("twoTurns", async (page) => {
        await waitForBootstrap(page);
        await createThread(page);

        await sendMessage(page, "First question");
        await assistantMessage(page, "First assistant reply.").waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });

        await sendMessage(page, "Second question");
        await assistantMessage(page, "Second assistant reply.").waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });
      });
    },
    30_000,
  );

  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "shows codex provider unavailable state",
    async () => {
      await runScenario("providerOffline", async (page) => {
        await waitForBootstrap(page);
        await providerBanner(page).waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });
        const bannerText = await providerBanner(page).textContent();
        expect(bannerText).toContain("codex provider is unavailable");
      });
    },
    30_000,
  );

  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "keeps composer editable after a completed turn",
    async () => {
      await runScenario("happyPath", async (page) => {
        await waitForBootstrap(page);
        await createThread(page);
        await sendMessage(page, "Explain how this harness works.");

        await assistantMessage(page, "Harness response for the first message.").waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });

        await composer(page).click();
        await page.keyboard.insertText("Draft after completion");
        const text = await composer(page).textContent();
        expect(text).toContain("Draft after completion");
      });
    },
    30_000,
  );
});
