/// <reference lib="dom" />
// Helpers for composer suggestion scenarios in short windows; the DOM lib types their page code.
import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

import type { T3 } from "./t3.ts";

const FILE_NAMES = Array.from(
  { length: 40 },
  (_, index) => `entry-${String(index + 1).padStart(2, "0")}.ts`,
);

/** Seeds a project with enough files to overflow the menu and opens a thread in it. */
export async function openThreadWithManyFiles(t3: T3) {
  const files = Object.fromEntries(FILE_NAMES.map((name) => [`src/${name}`, `export {};\n`]));
  const project = await t3.project("demo", files);
  const thread = await t3.thread({ project, title: "Short window", messages: ["hello"] });
  await t3.open(thread);
}

/** Types a fourteen-line draft, then opens the `@` file suggestions at its end. */
export async function openFileSuggestionsUnderTallDraft(browser: Browser, screen: Screen) {
  // A phone-width window collapses the composer until it is tapped.
  await screen.getByRole("button", "Expand composer").tap();
  await screen.getByRole("textbox").tap();
  for (let line = 1; line <= 14; line += 1) {
    await browser.keyboard.type(`line ${line}`);
    if (line < 14) await browser.keyboard.press("Shift+Enter");
  }
  await browser.keyboard.press("Control+End");
  await browser.keyboard.type(" @");
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelectorAll('[data-composer-command-drawer] [role="option"]').length,
      ),
    )
    .toBeGreaterThan(FILE_NAMES.length);
}

/** Wheels the suggestions from a point inside the visible drawer until they reach that end. */
export async function wheelSuggestions(browser: Browser, direction: "up" | "down") {
  const point = await browser.evaluate(() => {
    const layer = document.querySelector('[data-composer-drawer-layer="true"]');
    if (!layer) return null;
    const rect = layer.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    return { x: rect.left + rect.width / 2, y: top + (bottom - top) / 3 };
  });
  expect(point).not.toBeNull();
  await browser.mouse.move(point!.x, point!.y);
  // Wheel scrolling lands a frame or more later, so keep wheeling until the list is at its end.
  await expect
    .poll(async () => {
      await browser.mouse.wheel(0, direction === "down" ? 4000 : -4000);
      return browser.evaluate((direction) => {
        const viewport = document.querySelector(
          '[data-composer-command-drawer] [data-slot="scroll-area-viewport"]',
        );
        if (!viewport) return false;
        return direction === "down"
          ? viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1
          : viewport.scrollTop <= 0;
      }, direction);
    })
    .toBe(true);
}

/**
 * The first suggestion or last file row, and its center when the whole row is visible
 * and a click there lands on it, otherwise `null`.
 */
export const findHittableRow = (browser: Browser, which: "first" | "last-file") =>
  browser.evaluate(
    ({ which, names }) => {
      const options = [
        ...document.querySelectorAll<HTMLElement>('[data-composer-command-drawer] [role="option"]'),
      ];
      const row =
        which === "first"
          ? options[0]
          : options.findLast((option) =>
              names.some((name) => option.textContent?.startsWith(name)),
            );
      if (!row) return { label: null, point: null };
      const text = row.textContent ?? "";
      const label = names.find((name) => text.startsWith(name)) ?? text;
      const rect = row.getBoundingClientRect();
      const viewport = row.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
      const top = Math.max(0, viewport?.top ?? 0);
      const bottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight);
      if (rect.top < top - 1 || rect.bottom > bottom + 1) return { label, point: null };
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y)?.closest('[role="option"]') === row;
      return { label, point: hit ? point : null };
    },
    { which, names: [...FILE_NAMES, "README.md"] },
  );

export async function clickAt(browser: Browser, point: { readonly x: number; readonly y: number }) {
  await browser.mouse.move(point.x, point.y);
  await browser.mouse.down();
  await browser.mouse.up();
}
