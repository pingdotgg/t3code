/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// Without STIX Two Math, Latin Modern Math's 𝐵 inks about 0.17em past the box Words sizes from STIX.
const INK_ROOM_EM = 0.2;

test(
  "Inline math leaves room for glyph ink past its box",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("inline-math");
    await t3.open("/settings/appearance");
    await screen.getByRole("switch", "Render math").check();

    const thread = await t3.thread({ project, title: "Inline math", messages: ["first"] });
    await t3.open(thread);
    await screen.getByText("first fixture turn complete", { exact: false }).waitFor({
      timeout: 120_000,
    });
    // Seeded messages are sender-titled previews with plain text; a composer message is the user's
    // own, with its markdown body rendered.
    await screen.getByRole("textbox").fill("The field inside $B$, and $P$, $V$ stays put.");
    await browser.keyboard.press("Enter");
    await browser
      .locator('[data-message-role="user"] [data-markdown-math="inline"] > svg')
      .first()
      .waitFor();

    try {
      await expect
        .poll(
          () =>
            browser.evaluate((roomEm) => {
              const formulas = [
                ...document.querySelectorAll('[data-markdown-math="inline"] > svg'),
              ];
              if (formulas.length < 3) return "Inline math did not render";
              for (const svg of formulas) {
                const box = svg.getBoundingClientRect();
                const room = parseFloat(getComputedStyle(svg).fontSize) * roomEm;
                let clip = svg.parentElement;
                while (clip && getComputedStyle(clip).overflowX === "visible")
                  clip = clip.parentElement;
                if (!clip) continue;
                const left = clip.getBoundingClientRect().left + clip.clientLeft;
                if (box.left - room < left || box.right + room > left + clip.clientWidth)
                  return `Inline ${svg.getAttribute("aria-label")} clips ink past its box`;
                // The advance a formula takes in its line, which main gives as the SVG plus 2px a side.
                const wrapper = svg.parentElement!;
                const style = getComputedStyle(wrapper);
                const advance =
                  wrapper.getBoundingClientRect().width +
                  parseFloat(style.marginLeft) +
                  parseFloat(style.marginRight);
                const gap = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.25;
                if (Math.abs(advance - box.width - gap) > 0.5)
                  return `Inline ${svg.getAttribute("aria-label")} changes the spacing around it`;
              }
              return "Inline math leaves room for glyph ink";
            }, INK_ROOM_EM),
          { timeout: 20_000 },
        )
        .toBe("Inline math leaves room for glyph ink");
    } finally {
      await app.screenshot("inline-math");
    }
  },
);
