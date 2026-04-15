import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QRCodeSvg } from "./qr-code";

describe("QRCodeSvg", () => {
  it("renders with explicit high-contrast colors by default", () => {
    const markup = renderToStaticMarkup(<QRCodeSvg value="https://example.com/pair" />);

    expect(markup).toContain('fill="#fff"');
    expect(markup).toContain('fill="#000"');
    expect(markup).not.toContain('fill="currentColor"');
  });

  it("supports custom foreground and background colors", () => {
    const markup = renderToStaticMarkup(
      <QRCodeSvg
        value="https://example.com/pair"
        foregroundColor="#123456"
        backgroundColor="#abcdef"
      />,
    );

    expect(markup).toContain('fill="#abcdef"');
    expect(markup).toContain('fill="#123456"');
  });
});
