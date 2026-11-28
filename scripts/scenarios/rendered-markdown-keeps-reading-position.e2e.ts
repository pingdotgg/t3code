/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const sections = (name: string) =>
  Array.from(
    { length: 120 },
    (_, index) =>
      `## ${name} section ${index}\n\n${`Reading text for ${name} section ${index}. `.repeat(8)}\n`,
  ).join("\n");

test(
  "Rendered Markdown returns to where each file was being read",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("reading", {
      "long.md": sections("Long"),
      "other.md": sections("Other"),
    });
    const message =
      'See :codex-file-citation{path="long.md"} and :codex-file-citation{path="other.md"}';
    const first = await t3.thread({ project, title: "First reading", messages: [message] });
    await t3.thread({ project, title: "Second reading", messages: [message] });

    /** The first heading at or below the top of the rendered Markdown scroller. */
    const reading = () =>
      browser.evaluate(() => {
        const scroller = [...document.querySelectorAll<HTMLElement>(".scrollbar-gutter-both")].find(
          (element) => element.querySelector("h2"),
        );
        if (!scroller) return null;
        const top = scroller.getBoundingClientRect().top;
        for (const heading of scroller.querySelectorAll("h2"))
          if (heading.getBoundingClientRect().bottom > top) return heading.textContent;
        return null;
      });
    const scrollBy = (pixels: number) =>
      browser.evaluate((amount) => {
        const scroller = [...document.querySelectorAll<HTMLElement>(".scrollbar-gutter-both")].find(
          (element) => element.querySelector("h2"),
        );
        scroller?.scrollBy(0, amount);
        return null;
      }, pixels);
    const openFile = async (name: string) => {
      await screen.getByRole("link", new RegExp(`^${name.replace(".", "\\.")}`)).tap();
    };
    const expandMessage = () => screen.getByRole("button", /^Agent See/).tap();

    await t3.open(first);
    await expandMessage();
    await openFile("long.md");
    await screen.getByRole("button", "Show rendered markdown").tap();
    await expect.poll(reading).toBe("Long section 0");
    await scrollBy(3000);
    await expect.poll(reading).toMatch(/^Long section [1-9]/);
    const firstLong = await reading();

    await openFile("other.md");
    await expect.poll(reading).toBe("Other section 0");
    await scrollBy(1600);
    await expect.poll(reading).toMatch(/^Other section [1-9]/);

    await openFile("long.md");
    await app.screenshot("first-thread-long-reopened");
    await expect.poll(reading).toBe(firstLong);

    // Switch in the app: opening a thread by link reloads the page.
    const switchTo = (title: string) => screen.getByRole("button", title, { exact: false }).tap();
    await switchTo("Second reading");
    await expandMessage();
    await openFile("long.md");
    await expect.poll(reading).toBe("Long section 0");
    await scrollBy(5000);
    await expect.poll(reading).toMatch(/^Long section [1-9]/);
    const secondLong = await reading();

    await switchTo("First reading");
    await app.screenshot("first-thread-after-switch");
    await expect.poll(reading).toBe(firstLong);

    await switchTo("Second reading");
    await app.screenshot("second-thread-after-switch");
    await expect.poll(reading).toBe(secondLong);
  },
);
