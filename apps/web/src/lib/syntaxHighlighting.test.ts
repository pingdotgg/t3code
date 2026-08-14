import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

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

it("loads and caches each custom syntax theme independently", async () => {
  getSharedHighlighter.mockImplementation(({ themes }: { themes: string[] }) =>
    Promise.resolve({ theme: themes[0] }),
  );

  const rosePine = getSyntaxHighlighterPromise("typescript", "t3-syntax-dark-rose-pine");
  const dracula = getSyntaxHighlighterPromise("typescript", "t3-syntax-dark-dracula");

  expect(rosePine).not.toBe(dracula);
  await expect(rosePine).resolves.toEqual({ theme: "t3-syntax-dark-rose-pine" });
  await expect(dracula).resolves.toEqual({ theme: "t3-syntax-dark-dracula" });
  expect(getSharedHighlighter).toHaveBeenCalledWith(
    expect.objectContaining({ themes: ["t3-syntax-dark-rose-pine"] }),
  );
  expect(getSharedHighlighter).toHaveBeenCalledWith(
    expect.objectContaining({ themes: ["t3-syntax-dark-dracula"] }),
  );
});
