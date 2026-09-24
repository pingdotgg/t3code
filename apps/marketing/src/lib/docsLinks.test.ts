import { describe, expect, it } from "vite-plus/test";

import { docsHref } from "./docsLinks";

describe("docsHref", () => {
  it("rewrites relative page links to docs routes", () => {
    expect(docsHref("./install.md")).toBe("/docs/install/");
    expect(docsHref("./install.md#command-line")).toBe("/docs/install/#command-line");
    expect(docsHref("./README.md")).toBe("/docs/");
  });

  it("leaves other links alone", () => {
    expect(docsHref("#precedence")).toBe("#precedence");
    expect(docsHref("https://github.com/pingdotgg/t3code/blob/main/README.md")).toBe(
      "https://github.com/pingdotgg/t3code/blob/main/README.md",
    );
    expect(docsHref("../internals/overview.md")).toBe("../internals/overview.md");
  });
});
