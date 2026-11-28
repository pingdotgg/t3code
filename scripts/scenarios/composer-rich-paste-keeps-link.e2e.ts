/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const LABEL = "Setup guide";
const URL = "https://example.com/setup";
const PREFIX = "See the ";

test(
  "A hyperlink pasted into the composer keeps its destination",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Rich text paste", messages: ["first"] });
    await t3.open(thread);
    await screen.getByRole("textbox").tap();

    await browser.evaluate(
      ({ plain, html }) => {
        const editor = document.activeElement;
        if (!(editor instanceof HTMLElement) || !editor.isContentEditable) {
          throw new Error("The composer is not focused");
        }
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", plain);
        clipboardData.setData("text/html", html);
        editor.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
        return null;
      },
      { plain: PREFIX + LABEL, html: `<p>${PREFIX}<a href="${URL}">${LABEL}</a></p>` },
    );

    await browser.keyboard.press("Enter");
    await screen.getByText("second fixture turn complete").waitFor();
    await app.screenshot("sent-pasted-link");

    const destination = await browser.evaluate((prefix) => {
      const message = [...document.querySelectorAll("[data-user-message-body]")].find((body) =>
        body.textContent?.includes(prefix),
      );
      if (!message) throw new Error("The pasted message is missing");
      return message.querySelector("a")?.getAttribute("href") ?? null;
    }, PREFIX);
    expect(destination).toBe(URL);
  },
);
