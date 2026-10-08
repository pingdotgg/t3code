// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readThreadFindPosition } from "./threadFindPosition";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: () => new DOMRect(),
  });
});

function viewport(text = "COD4 COD4") {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="above"><div data-thread-find-text>COD4</div></div>
    <div data-timeline-row-id="reading"><div data-thread-find-text>${text}</div></div>`;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 400));
  vi.spyOn(container.children[0]!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 80),
  );
  vi.spyOn(container.children[1]!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 50, 500, 300),
  );
  return container;
}

describe("reading position for find", () => {
  it("skips earlier rows and occurrences above the viewport within the current message", () => {
    const container = viewport();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return new DOMRect(0, this.startOffset === 0 ? 60 : 160, 40, 20);
    });
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toEqual({
      entryId: "reading",
      occurrence: 1,
    });
  });

  it("starts after the current message when all its occurrences are above the viewport", () => {
    const container = viewport();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 40, 20));
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toEqual({
      entryId: "reading",
      occurrence: 2,
    });
  });

  it("anchors unmatched or folded content and excludes rows hidden behind the composer", () => {
    const container = viewport("nothing");
    expect(readThreadFindPosition(container, "COD4", () => "folded-message", 100)).toEqual({
      entryId: "folded-message",
      occurrence: 0,
    });
    vi.spyOn(container.children[1]!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 420, 500, 300),
    );
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toBeUndefined();
  });
});
