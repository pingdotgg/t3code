import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OpenCode2Icon, OpenCodeIcon } from "./Icons";

const OPEN_CODE_2_DIGIT_PATH =
  "M8 8H24V12H8V8ZM20 12H24V20H20V12ZM8 16H20V20H8V16ZM8 20H12V28H8V20ZM8 28H24V32H8V28Z";

function markPaths(markup: string): ReadonlyArray<string> {
  return [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);
}

describe("OpenCode icons", () => {
  it("keeps the shared frame while preview uses the official dev blue treatment", () => {
    const openCode = renderToStaticMarkup(<OpenCodeIcon />);
    const openCode2 = renderToStaticMarkup(<OpenCode2Icon />);

    expect(openCode).toContain('viewBox="0 0 32 40"');
    expect(openCode2).toContain('viewBox="0 0 32 40"');
    expect(openCode2).not.toContain("stroke=");
    expect(markPaths(openCode2).slice(-2)).toEqual(markPaths(openCode).slice(-2));
    expect(openCode2).toContain('fill="#2E6CE9"');
    expect(openCode2).toContain('fill="#82C4FF"');
    expect(openCode2).toContain('fill="#0A2055"');
  });

  it("no longer draws a version number into the OpenCode 2 glyph", () => {
    expect(renderToStaticMarkup(<OpenCode2Icon />)).not.toContain(OPEN_CODE_2_DIGIT_PATH);
  });

  it("keeps the two generations identifiable in the DOM", () => {
    expect(renderToStaticMarkup(<OpenCodeIcon />)).toContain('data-provider-icon="opencode"');
    expect(renderToStaticMarkup(<OpenCode2Icon />)).toContain('data-provider-icon="opencode2"');
  });
});
