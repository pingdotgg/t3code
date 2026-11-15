/// <reference lib="dom" />
// The DOM lib types the functions these helpers run in the page.
// Opens the composer's file suggestions under a tall draft, wheels them to one end, and finds
// where a pointer can still hit a row, for scenarios about short windows.
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

/** Wheels the suggestions from a point inside the visible drawer until they stop scrolling. */
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
  const scrollTop = () =>
    browser.evaluate(
      () =>
        document.querySelector(
          '[data-composer-command-drawer] [data-slot="scroll-area-viewport"]',
        )?.scrollTop ?? -1,
    );
  let previous = -1;
  let current = await scrollTop();
  while (current !== previous) {
    await browser.mouse.wheel(0, direction === "down" ? 4000 : -4000);
    previous = current;
    current = await scrollTop();
  }
}

/**
 * The first or last suggestion row, and a point inside the window where `elementFromPoint`
 * lands on that row, or `null` when no part of it can be hit.
 */
export const findHittableRow = (browser: Browser, which: "first" | "last") =>
  browser.evaluate(
    ({ which, names }) => {
      const options = [
        ...document.querySelectorAll<HTMLElement>('[data-composer-command-drawer] [role="option"]'),
      ];
      const row = which === "first" ? options[0] : options.at(-1);
      if (!row) return { label: null, point: null };
      const text = row.textContent ?? "";
      const label = names.find((name) => text.startsWith(name)) ?? text;
      const rect = row.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      for (let y = Math.ceil(rect.top) + 1; y < rect.bottom - 1; y += 2) {
        if (y < 0 || y >= window.innerHeight) continue;
        if (document.elementFromPoint(x, y)?.closest('[role="option"]') === row) {
          return { label, point: { x, y } };
        }
      }
      return { label, point: null };
    },
    { which, names: [...FILE_NAMES, "README.md", "src"] },
  );

/** Clicks a point with the primary pointer button. */
export async function clickAt(browser: Browser, point: { readonly x: number; readonly y: number }) {
  await browser.mouse.move(point.x, point.y);
  await browser.mouse.down();
  await browser.mouse.up();
}
