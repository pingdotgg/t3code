import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// The thread CLI takes at most 120,000 characters per message: 3,000 lines of ten "the".
const SEEDED_MATCHES = 30_000;
const LONG_MESSAGE = Array.from({ length: SEEDED_MATCHES / 10 }, () =>
  "the ".repeat(10).trim(),
).join("\n");

const findTotal = `(() => {
  const label = document.querySelector("[data-thread-find-bar] span[aria-hidden]")?.textContent ?? "";
  const match = /^\\d+\\/(\\d+)$/.exec(label.trim());
  return match ? Number(match[1]) : 0;
})()`;

const paint = `(() => {
  const inactive = CSS.highlights.get("t3-thread-find");
  const active = CSS.highlights.get("t3-thread-find-active");
  let onScreen = 0;
  for (const highlight of [inactive, active])
    for (const range of highlight ?? []) {
      const rect = range.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight) onScreen++;
    }
  return {
    registered: (inactive?.size ?? 0) + (active?.size ?? 0),
    active: active?.size ?? 0,
    onScreen,
  };
})()`;

test(
  "Find paints only matches near the viewport of a message with 30,000 matches",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("find-paint");
    const thread = await t3.thread({
      project,
      title: "Paint bound proof",
      messages: [LONG_MESSAGE],
    });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible({
      timeout: 120_000,
    });

    // The CLI's message folds to one line; find unfolds it to reach the first match.
    await browser.keyboard.press("Control+f");
    const find = screen.getByRole("searchbox", "Find in thread");
    await expect(find).toBeVisible();
    await find.fill("the");
    // The count is the server's: every match in the thread, whatever is painted.
    await expect
      .poll(() => browser.evaluate<number>(findTotal), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(SEEDED_MATCHES);
    await expect
      .poll(async () => (await browser.evaluate<{ active: number }>(paint)).active, {
        timeout: 30_000,
      })
      .toBe(1);

    try {
      const painted = await browser.evaluate<{
        registered: number;
        active: number;
        onScreen: number;
      }>(paint);
      expect(painted.onScreen).toBeGreaterThan(0);
      expect(painted.registered).toBeLessThan(5_000);
    } finally {
      await app.screenshot("find-open-paint");
    }
  },
);
