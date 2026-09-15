import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Textarea } from "./textarea";

describe("textarea", () => {
  it("wraps long unbroken values instead of growing past its container", () => {
    const html = renderToStaticMarkup(
      <Textarea defaultValue='ln -s "$HOME/Code/example-project/a-very-long-directory-name/another-long-directory-name/src/config/Secrets.swift" "src/config/Secrets.swift"' />,
    );

    expect(html).toContain("min-w-0");
    expect(html).toContain("max-w-full");
    expect(html).toContain("wrap-anywhere");
  });
});
