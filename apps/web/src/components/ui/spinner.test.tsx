import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProgressSpinner } from "./spinner";

describe("ProgressSpinner", () => {
  it("renders bounded determinate progress", () => {
    const progress = renderToStaticMarkup(
      <ProgressSpinner value={42.5} aria-label="Downloading update" />,
    );
    const overflow = renderToStaticMarkup(
      <ProgressSpinner value={120} aria-label="Downloading update" />,
    );
    const underflow = renderToStaticMarkup(
      <ProgressSpinner value={-20} aria-label="Downloading update" />,
    );
    const invalid = renderToStaticMarkup(
      <ProgressSpinner value={Number.NaN} aria-label="Downloading update" />,
    );

    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-label="Downloading update"');
    expect(progress).toContain('aria-valuenow="42.5"');
    expect(progress).toContain('stroke-dashoffset="57.5"');
    expect(overflow).toContain('aria-valuenow="100"');
    expect(overflow).toContain('stroke-dashoffset="0"');
    expect(underflow).toContain('aria-valuenow="0"');
    expect(underflow).toContain('stroke-dashoffset="100"');
    expect(invalid).toContain('aria-valuenow="0"');
  });
});
