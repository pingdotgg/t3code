import { Suspense } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DIFF_THEME_NAMES, type DiffThemeName } from "../../lib/diffRendering";
import { LRUCache } from "../../lib/lruCache";
import { createHighlightCacheKey } from "./MarkdownCodeBlock.logic";

const hashedCodes = vi.hoisted(() => [] as string[]);
vi.mock("./MarkdownCodeBlock.logic", () => ({
  createHighlightCacheKey: (code: string, language: string, themeName: string) => {
    hashedCodes.push(code);
    return `${code}:${language}:${themeName}`;
  },
  estimateHighlightedSize: (html: string, code: string) => html.length + code.length,
  extractFenceLanguage: (className: string | undefined) =>
    className?.replace("language-", "") ?? "text",
}));

import { SuspenseShikiCodeBlock } from "./MarkdownCodeBlock";

function setup() {
  hashedCodes.length = 0;
  const cacheWrites = vi.spyOn(LRUCache.prototype, "set");
  return {
    writtenKeys: () => cacheWrites.mock.calls.map(([key]) => key),
    [Symbol.dispose]: () => cacheWrites.mockRestore(),
  };
}

function block(
  code: string,
  isStreaming: boolean,
  { language = "ts", themeName = DIFF_THEME_NAMES.light as DiffThemeName } = {},
) {
  return (
    <Suspense fallback={null}>
      <SuspenseShikiCodeBlock
        className={`language-${language}`}
        code={code}
        themeName={themeName}
        isStreaming={isStreaming}
      />
    </Suspense>
  );
}

const keyOf = (code: string, language = "ts", themeName: DiffThemeName = DIFF_THEME_NAMES.light) =>
  createHighlightCacheKey(code, language, themeName);

it("hashes a streaming fence only once it finishes, and caches each finished text", async () => {
  using cache = setup();
  await using screen = await render(block("const stream = 1;", true));
  const { container, rerender } = screen;
  await vi.waitFor(() => expect(container.textContent).toContain("const stream = 1;"));

  await rerender(block("const stream = 1;\nconst other = 2;", true));
  await rerender(block("const stream = 1;\nconst shrunk", true));
  await rerender(block("const stream = 1;\nconst done = 3;", true));
  expect(hashedCodes).toEqual([]);
  expect(cache.writtenKeys()).toEqual([]);

  const line = container.querySelector("code > *")!;
  window.getSelection()!.selectAllChildren(line);
  const selected = window.getSelection()!.toString();
  expect(selected).toContain("const stream = 1;");

  const finished = "const stream = 1;\nconst done = 3;";
  await rerender(block(finished, false));
  expect(new Set(hashedCodes)).toEqual(new Set([finished]));
  const firstKey = keyOf(finished);
  expect(cache.writtenKeys()).toEqual([firstKey]);
  expect(container.querySelector("code > *")).toBe(line);
  expect(window.getSelection()!.toString()).toBe(selected);

  hashedCodes.length = 0;
  const restarted = `${finished}\nconst again = 4;`;
  await rerender(block(restarted, true));
  expect(hashedCodes).toEqual([]);
  expect(container.querySelector("code > *")).toBe(line);
  await rerender(block(restarted, false));
  expect(cache.writtenKeys()).toEqual([firstKey, keyOf(restarted)]);

  await rerender(block(restarted, false, { themeName: DIFF_THEME_NAMES.dark }));
  await rerender(block(restarted, false, { language: "js" }));
  expect(cache.writtenKeys()).toEqual([
    firstKey,
    keyOf(restarted),
    keyOf(restarted, "ts", DIFF_THEME_NAMES.dark),
    keyOf(restarted, "js"),
  ]);
});

it("serves a finished block from the cache on the next mount", async () => {
  using cache = setup();
  const finished = "const remounted = 5;";
  {
    await using first = await render(block(finished, true));
    await vi.waitFor(() => expect(first.container.textContent).toContain(finished));
    await first.rerender(block(finished, false));
  }
  expect(cache.writtenKeys()).toEqual([keyOf(finished)]);

  await using screen = await render(block(finished, false));
  expect(screen.container.textContent).toContain(finished);
  expect(cache.writtenKeys()).toEqual([keyOf(finished)]);
});
