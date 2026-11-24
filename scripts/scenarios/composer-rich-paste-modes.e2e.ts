/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const LABEL = "Setup guide";
const URL = "https://example.com/setup";
const UNKNOWN_THREAD_URL = "https://app.t3.codes/threads/env-1/thread-1";
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AP8AAAMBAQCNHeWCAAAAAElFTkSuQmCC";

for (const mode of [
  "Paste as Text",
  "Paste with an image",
  "Paste a thread link with an image",
] as const) {
  test(
    `${mode} respects the focused composer's clipboard mode`,
    WEB,
    async ({ t3, browser, screen }) => {
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: mode, messages: ["first"] });
      await t3.open(thread);
      const composer = screen.getByRole("textbox");
      await composer.tap();

      await browser.evaluate(
        ({ mode, label, url, pixel }) => {
          const editor = document.activeElement;
          if (!(editor instanceof HTMLElement) || !editor.isContentEditable) {
            throw new Error("The composer is not focused");
          }
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", label);
          const anchor = `<a href="${url}">${label}</a>`;
          if (mode === "Paste as Text") {
            const isMac = navigator.platform.startsWith("Mac");
            editor.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "V",
                code: "KeyV",
                ctrlKey: !isMac,
                metaKey: isMac,
                shiftKey: true,
                bubbles: true,
              }),
            );
            clipboardData.setData("text/html", anchor);
          } else {
            const bytes = Uint8Array.from(atob(pixel), (char) => char.charCodeAt(0));
            clipboardData.items.add(new File([bytes], "setup.png", { type: "image/png" }));
            clipboardData.setData("text/html", `${anchor}<img alt="">`);
          }
          editor.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
          return null;
        },
        {
          mode,
          label: LABEL,
          url: mode === "Paste a thread link with an image" ? UNKNOWN_THREAD_URL : URL,
          pixel: PIXEL,
        },
      );

      if (mode !== "Paste as Text") {
        await expect(screen.getByRole("button", "Remove setup.png")).toBeVisible();
      }
      if (mode === "Paste a thread link with an image") {
        const text = await browser.evaluate(() => document.activeElement?.textContent ?? "");
        expect(text).toBe(`[${LABEL}](${UNKNOWN_THREAD_URL})`);
        return;
      }
      await browser.keyboard.press("Enter");
      await screen.getByText("second fixture turn complete").waitFor();
      const destination = await browser.evaluate((label) => {
        const message = [...document.querySelectorAll("[data-user-message-body]")].find((body) =>
          body.textContent?.includes(label),
        );
        if (!message) throw new Error("The pasted message is missing");
        return message.querySelector("a")?.getAttribute("href") ?? null;
      }, LABEL);
      expect(destination).toBe(mode === "Paste as Text" ? null : URL);
    },
  );
}
