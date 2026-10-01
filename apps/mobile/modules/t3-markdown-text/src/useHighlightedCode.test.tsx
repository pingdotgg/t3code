import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MarkdownCodeHighlighter } from "./SelectableMarkdownText.types";
import { useHighlightedCode, type HighlightedCode } from "./useHighlightedCode";

type Deferred = {
  readonly code: string;
  readonly resolve: (tokens: HighlightedCode) => void;
};

/** One colored line per newline-separated line, so a line's color proves where it came from. */
function tokensFor(code: string, color: string): HighlightedCode {
  return code.split("\n").map((content) => [{ content, color, fontStyle: 0 }]);
}

function lineText(tokens: HighlightedCode | null): string | null {
  return tokens?.map((line) => line.map((token) => token.content).join("")).join("\n") ?? null;
}

function lineColors(tokens: HighlightedCode | null): ReadonlyArray<string | null> {
  return tokens?.map((line) => line[0]?.color ?? null) ?? [];
}

const deferred: Deferred[] = [];
const readResults = new Map<string, HighlightedCode>();
let renders = 0;
let result: HighlightedCode | null = null;
let root: Root;

const highlightCode: MarkdownCodeHighlighter = Object.assign(
  vi.fn(
    (input: { code: string }) =>
      new Promise<HighlightedCode>((resolve) => {
        deferred.push({ code: input.code, resolve });
      }),
  ),
  {
    read: vi.fn((input: { code: string }) => readResults.get(input.code)),
  },
);

function Probe(props: {
  readonly code: string;
  readonly language?: string;
  readonly theme?: "light" | "dark";
}) {
  const tokens = useHighlightedCode(
    props.code,
    props.language ?? "ts",
    props.theme ?? "dark",
    highlightCode,
  );
  useLayoutEffect(() => {
    renders += 1;
    result = tokens;
  });
  return null;
}

async function render(props: Parameters<typeof Probe>[0]) {
  await act(() => root.render(<Probe {...props} />));
}

async function resolveAsync(index: number, color: string) {
  const pending = deferred[index];
  if (!pending) throw new Error(`no pending highlight at ${index}`);
  await act(async () => {
    pending.resolve(tokensFor(pending.code, color));
  });
}

beforeEach(async () => {
  // The probe has no DOM output, but ReactDOM needs an event target.
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  deferred.length = 0;
  readResults.clear();
  renders = 0;
  result = null;
  vi.mocked(highlightCode).mockClear();
  vi.mocked(highlightCode.read!).mockClear();
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

// Every test uses a distinct language so the module-level token cache from an
// earlier test can never satisfy a later one.
describe("useHighlightedCode", () => {
  it("keeps colors from the latest synchronous read when a later read misses", async () => {
    const language = "sync-baseline";
    await render({ code: "a", language });
    expect(result).toBeNull();
    await resolveAsync(0, "async");
    expect(lineColors(result)).toEqual(["async"]);

    readResults.set("a\nb", tokensFor("a\nb", "sync-1"));
    readResults.set("a\nb\nc", tokensFor("a\nb\nc", "sync-2"));
    const rendersBeforeAppends = renders;
    await render({ code: "a\nb", language });
    await render({ code: "a\nb\nc", language });
    expect(lineColors(result)).toEqual(["sync-2", "sync-2", "sync-2"]);
    // A synchronous hit is one render per append: no state update, no highlighter call.
    expect(renders - rendersBeforeAppends).toBe(2);
    expect(highlightCode).toHaveBeenCalledTimes(1);

    await render({ code: "a\nb\nc\nd", language });
    expect(highlightCode).toHaveBeenCalledTimes(2);
    expect(lineText(result)).toBe("a\nb\nc\nd");
    // Lines before the previous code's final newline are the completed ones.
    expect(lineColors(result)).toEqual(["sync-2", "sync-2", null, null]);

    await resolveAsync(1, "async-2");
    expect(lineColors(result)).toEqual(["async-2", "async-2", "async-2", "async-2"]);
  });

  it("does not show obsolete text after a non-append edit", async () => {
    const language = "non-append";
    await render({ code: "a\nb", language });
    await resolveAsync(0, "async");
    readResults.set("a\nb\nc", tokensFor("a\nb\nc", "sync"));
    await render({ code: "a\nb\nc", language });
    expect(lineColors(result)).toEqual(["sync", "sync", "sync"]);

    await render({ code: "x\nb\nc", language });
    expect(result).toBeNull();
    await resolveAsync(1, "async-2");
    expect(lineText(result)).toBe("x\nb\nc");
  });

  it("never reuses colors across a language or theme change", async () => {
    const language = "theme-change";
    await render({ code: "a\nb", language });
    await resolveAsync(0, "async");
    readResults.set("a\nb\nc", tokensFor("a\nb\nc", "sync"));
    await render({ code: "a\nb\nc", language });
    expect(lineColors(result)).toEqual(["sync", "sync", "sync"]);

    await render({ code: "a\nb\nc\nd", language, theme: "light" });
    expect(result).toBeNull();
    await render({ code: "a\nb\nc\nd", language: `${language}-other` });
    expect(result).toBeNull();
  });

  it("ignores an asynchronous completion that is older than the current code", async () => {
    const language = "stale-async";
    await render({ code: "a\nb", language });
    await resolveAsync(0, "async");

    await render({ code: "a\nb\nc", language });
    expect(deferred).toHaveLength(2);
    expect(lineColors(result)).toEqual(["async", null, null]);

    readResults.set("a\nb\nc\nd", tokensFor("a\nb\nc\nd", "sync"));
    await render({ code: "a\nb\nc\nd", language });
    expect(lineColors(result)).toEqual(["sync", "sync", "sync", "sync"]);

    await render({ code: "a\nb\nc\nd\ne", language });
    expect(deferred).toHaveLength(3);
    expect(lineColors(result)).toEqual(["sync", "sync", "sync", null, null]);

    // The older request finishes after newer synchronous results exist.
    await resolveAsync(1, "stale");
    expect(lineText(result)).toBe("a\nb\nc\nd\ne");
    expect(lineColors(result)).toEqual(["sync", "sync", "sync", null, null]);

    await resolveAsync(2, "async-3");
    expect(lineColors(result)).toEqual(["async-3", "async-3", "async-3", "async-3", "async-3"]);
  });
});
