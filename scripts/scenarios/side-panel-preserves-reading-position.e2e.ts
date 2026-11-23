/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const text = Array.from(
  { length: 70 },
  (_, index) =>
    `Sentence ${index + 1}. Opening a side panel should keep the sentence being read visible while the text wraps to the available width. `,
).join("");

test(
  "Opening a side panel preserves the visible text in the conversation and draft",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({
      project,
      title: "Reading position",
      messages: ["Start"],
      model: "multi-turn",
    });
    await browser.setViewport({ width: 1440, height: 1000 });
    await t3.open(thread);
    await screen.getByRole("button", "Toggle thread details panel").tap();
    await screen.getByRole("textbox").fill(text);
    await screen.getByRole("textbox").press("Enter");
    await screen.getByText("second fixture turn complete", { exact: false }).waitFor();
    await screen.getByRole("button", "Show full message").tap();

    const position = (draft: boolean, place: boolean) =>
      browser.evaluate(
        async ({ draft, place }) => {
          const scroller = document.querySelector<HTMLElement>(
            draft ? ".composer-tiptap" : ".messages-timeline-scroll",
          )!;
          const content = draft
            ? scroller
            : Array.from(scroller.querySelectorAll("[data-user-message-body]")).find(
                (body) => (body.textContent?.length ?? 0) >= 3000,
              );
          if (!content) throw new Error("The long message is not rendered");
          const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node && (node.textContent?.length ?? 0) < 3000) node = walker.nextNode();
          if (!node) throw new Error("The long paragraph is not rendered");
          const range = document.createRange();
          range.setStart(node, 2500);
          range.collapse(true);
          if (place) {
            scroller.blur();
            scroller.scrollTop +=
              range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 48;
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
          );
          return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        },
        { draft, place },
      );

    const point = await browser.evaluate(() => {
      const box = document.querySelector(".messages-timeline-scroll")!.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + 150 };
    });
    await browser.mouse.move(point.x, point.y);
    await browser.mouse.wheel(0, -800);
    // The wheel's native scroll completes asynchronously before positioning the fixture text.
    await browser.evaluate(
      () =>
        new Promise<null>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
        ),
    );
    let timelineBefore = await position(false, true);
    if (Math.abs(timelineBefore - 48) > 2) timelineBefore = await position(false, true);
    if (Math.abs(timelineBefore - 48) > 2)
      throw new Error(`The conversation did not settle at the reading position: ${timelineBefore}`);
    await app.screenshot("conversation-panel-closed");
    await screen.getByRole("button", "Toggle right panel").tap();
    const timelineAfter = await position(false, false);
    await app.screenshot("conversation-panel-open");
    await screen.getByRole("button", "Toggle right panel").tap();

    await screen.getByRole("textbox").fill(text);
    const draftBefore = await position(true, true);
    if (Math.abs(draftBefore - 48) > 2)
      throw new Error("The draft did not settle at the reading position");
    await app.screenshot("draft-panel-closed");
    await screen.getByRole("button", "Toggle right panel").tap();
    const draftAfter = await position(true, false);
    await app.screenshot("draft-panel-open");

    // The panel shortcut is pressed inside the focused draft, with a caret and then a selection.
    const shortcutShifts: number[] = [];
    for (const length of [0, 20]) {
      const shortcutBefore = await browser.evaluate((length) => {
        const scroller = document.querySelector<HTMLElement>(".composer-tiptap")!;
        scroller.focus();
        const node = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT).nextNode()!;
        document.getSelection()!.setBaseAndExtent(node, 2500, node, 2500 + length);
        const range = document.createRange();
        range.setStart(node, 2500);
        scroller.scrollTop +=
          range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 48;
        return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }, length);
      await browser.keyboard.press("Control+Alt+B");
      shortcutShifts.push(Math.abs((await position(true, false)) - shortcutBefore));
      await app.screenshot(length === 0 ? "draft-caret-shortcut" : "draft-selection-shortcut");
    }

    expect(
      Math.max(
        Math.abs(timelineAfter - timelineBefore),
        Math.abs(draftAfter - draftBefore),
        ...shortcutShifts,
      ),
    ).toBeLessThan(30);
  },
);
