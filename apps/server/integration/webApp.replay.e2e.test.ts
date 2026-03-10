import fs from "node:fs";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { createWebAppReplayHarness } from "./WebAppReplayHarness.ts";

const shouldRunE2E = process.env.T3CODE_E2E === "1";
const chromiumInstalled = fs.existsSync(chromium.executablePath());
const STEP_TIMEOUT_MS = 10_000;

describe("web app replay e2e", () => {
  it.skipIf(!shouldRunE2E || !chromiumInstalled)(
    "creates a new thread and sends the first message through backend IO replay",
    async () => {
      const harness = await createWebAppReplayHarness(import.meta.url);
      const browser = await chromium.launch({ headless: true });
      const { context, page } = await harness.openPage(browser, {
        viewport: { width: 1440, height: 1024 },
      });
      const consoleMessages: string[] = [];
      const pageErrors: string[] = [];

      page.on("console", (message) => {
        consoleMessages.push(`[${message.type()}] ${message.text()}`);
      });
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });

      const debugContext = async () => {
        const bodyText = (await page.locator("body").textContent().catch(() => null))?.trim() ?? "";
        return [
          `url=${page.url()}`,
          pageErrors.length > 0 ? `pageErrors=${pageErrors.join(" | ")}` : null,
          consoleMessages.length > 0 ? `console=${consoleMessages.join(" | ")}` : null,
          bodyText.length > 0 ? `body=${bodyText.slice(0, 800)}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join("\n");
      };

      try {
        await page.goto(harness.appUrl, { waitUntil: "domcontentloaded" });
        await page
          .getByRole("button", { name: /Create new thread in/i })
          .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
          .catch(async (error) => {
            throw new Error(`New-thread button never appeared.\n${await debugContext()}`, {
              cause: error,
            });
          });
        await page
          .getByText("Send a message to start the conversation.")
          .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
          .catch(async (error) => {
            throw new Error(`Empty-thread state never appeared.\n${await debugContext()}`, {
              cause: error,
            });
          });

        const bootstrapPath = new URL(page.url()).pathname;

        await page.getByRole("button", { name: /Create new thread in/i }).click();
        await page.waitForURL(
          (url) => {
            return new URL(String(url)).pathname !== bootstrapPath;
          },
          { timeout: STEP_TIMEOUT_MS },
        );

        const draftThreadPath = new URL(page.url()).pathname;
        const prompt = "Explain how the replay harness works.";

        const composer = page.locator('[contenteditable="true"]').first();
        await composer.click();
        await page.keyboard.insertText(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        await page
          .getByText("Replay harness response for the first message.")
          .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
          .catch(async (error) => {
            throw new Error(`Assistant replay response never rendered.\n${await debugContext()}`, {
              cause: error,
            });
          });

        expect(new URL(page.url()).pathname).toBe(draftThreadPath);
      } finally {
        await context.close();
        await browser.close();
        await harness.dispose();
      }
    },
    30_000,
  );
});
