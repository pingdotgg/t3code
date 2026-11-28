/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const ARABIC = "مرحبا بالعالم.";
const ENGLISH = "Hello world.";
const MESSAGE = ["Draft:", "", "```md", ARABIC, "**ملاحظة**: هذا سطر عربي.", ENGLISH, "```"].join(
  "\n",
);

test(
  "Arabic lines in a markdown fence read right to left beside English ones",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Arabic fence", messages: [MESSAGE] });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Draft/).tap();
    await screen.getByText(ENGLISH, { exact: false }).waitFor({ timeout: 120_000 });

    const layout = await browser.evaluate(
      ({ arabic, english }) => {
        const pre = document.querySelector<HTMLElement>(
          '[data-user-message-body] .chat-markdown-codeblock[data-language="md"] pre',
        );
        if (!pre) return null;
        const style = getComputedStyle(pre);
        const box = pre.getBoundingClientRect();
        const contentLeft = box.left + parseFloat(style.paddingLeft);
        const contentRight = box.right - parseFloat(style.paddingRight);
        const lineRect = (text: string) => {
          const line = [...pre.querySelectorAll<HTMLElement>(".line")].find(
            (element) => element.textContent === text,
          );
          if (!line) return null;
          const range = document.createRange();
          range.selectNodeContents(line);
          return { range, rect: range.getBoundingClientRect() };
        };
        const arabicLine = lineRect(arabic);
        const englishLine = lineRect(english);
        if (!arabicLine || !englishLine) return null;
        const walker = document.createTreeWalker(arabicLine.range.commonAncestorContainer, 4);
        let stop: DOMRect | null = null;
        let firstLetter: DOMRect | null = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent ?? "";
          const charRect = (index: number) => {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            return range.getBoundingClientRect();
          };
          if (!firstLetter && value.length > 0) firstLetter = charRect(0);
          if (value.includes(".")) stop = charRect(value.indexOf("."));
        }
        if (!stop || !firstLetter) return null;
        return {
          arabicAlignedRight: Math.abs(arabicLine.rect.right - contentRight) <= 2,
          arabicStopOnLeft: stop.right <= firstLetter.left + 1,
          englishAlignedLeft: Math.abs(englishLine.rect.left - contentLeft) <= 2,
        };
      },
      { arabic: ARABIC, english: ENGLISH },
    );
    await app.screenshot("arabic-markdown-fence");
    expect(layout, "Arabic lines start on the right and end with a full stop on the left").toEqual({
      arabicAlignedRight: true,
      arabicStopOnLeft: true,
      englishAlignedLeft: true,
    });
  },
);
