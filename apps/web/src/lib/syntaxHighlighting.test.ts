import type { DiffsHighlighter } from "@pierre/diffs";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

beforeEach(() => {
  getSharedHighlighter.mockReset();
});

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language", "pierre-dark");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language", "pierre-dark");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

it("does not reuse a highlighter built for a different syntax theme", async () => {
  const highlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockResolvedValue(highlighter);

  const first = getSyntaxHighlighterPromise("typescript", "t3-syntax-a-dark");
  const second = getSyntaxHighlighterPromise("typescript", "t3-syntax-b-dark");

  expect(second).not.toBe(first);
  await expect(first).resolves.toBe(highlighter);
  await expect(second).resolves.toBe(highlighter);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
  expect(getSharedHighlighter).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ themes: ["t3-syntax-a-dark"], langs: ["typescript"] }),
  );
  expect(getSharedHighlighter).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ themes: ["t3-syntax-b-dark"], langs: ["typescript"] }),
  );
});
