import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MiddleTruncate, splitForMiddleTruncate } from "./middle-truncate";

describe("splitForMiddleTruncate", () => {
  it("cuts a branch label exactly at the space before the name", () => {
    expect(splitForMiddleTruncate("From new-design")).toEqual({
      head: "From ",
      tail: "new-design",
    });
  });
});

describe("MiddleTruncate", () => {
  it("renders head and tail with preserved whitespace so the boundary space survives", () => {
    const html = renderToStaticMarkup(<MiddleTruncate value="From new-design" />);
    const spans = [...html.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)];
    expect(spans.map((match) => match[2])).toEqual(["From ", "new-design"]);
    for (const match of spans) {
      expect(match[1]).toContain("whitespace-pre");
      expect(match[1]).not.toContain("truncate");
    }
    expect(spans[0]?.[1]).toContain("text-ellipsis");
  });

  it("keeps the split label on one line when the value contains line breaks", () => {
    const value = "From new\r\ndesign-x\nlong-name";
    expect(splitForMiddleTruncate(value)).not.toBeNull();
    const html = renderToStaticMarkup(<MiddleTruncate value={value} />);
    const spans = [...html.matchAll(/<span class="[^"]*whitespace-pre[^"]*">([^<]*)<\/span>/g)];
    expect(spans).toHaveLength(2);
    for (const match of spans) {
      expect(match[1]).not.toMatch(/[\r\n]/);
    }
    expect(spans.map((match) => match[1]).join("")).toBe("From new  design-x long-name");
  });
});
