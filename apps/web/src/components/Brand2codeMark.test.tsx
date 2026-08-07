import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Brand2codeMark } from "./Brand2codeMark";

describe("Brand2codeMark", () => {
  it("renders the canonical accessible rounded-diamond mark", () => {
    const markup = renderToStaticMarkup(<Brand2codeMark className="size-6" />);

    expect(markup).toContain('aria-label="2code"');
    expect(markup).toContain('transform="rotate(45 12 12)"');
    expect(markup).toContain('rx="5"');
    expect(markup).toContain("#b0fe93");
  });
});
