import { describe, expect, it } from "vite-plus/test";
import { markdownWithTopLevelCodeBlocks } from "./markdownDocument";

describe("markdownWithTopLevelCodeBlocks", () => {
  it("moves a fence in a list item to the top level and continues the list after it", () => {
    expect(
      markdownWithTopLevelCodeBlocks(
        "1. Run this:\n   ```bash\n   cd /tmp && \\\n     rm -rf x\n   ```\n   Then wait.\n1. Next step.\n",
      ),
    ).toBe(
      "1. Run this:\n\n```bash\ncd /tmp && \\\n  rm -rf x\n```\n\nThen wait.\n\n2. Next step.\n",
    );
  });

  it("moves fences out of nested lists and fences on the marker line", () => {
    expect(markdownWithTopLevelCodeBlocks("- a\n  - b\n    ~~~\n    x\n    ~~~\n  - c\n- d")).toBe(
      "- a\n  - b\n\n~~~\nx\n~~~\n\n- c\n- d",
    );
    expect(markdownWithTopLevelCodeBlocks("- ```sh\n  ls\n  ```\n- next")).toBe(
      "-\n\n```sh\nls\n```\n\n- next",
    );
  });

  it("leaves top-level and indented code blocks alone", () => {
    for (const markdown of [
      "```sh\nls\n```\n- item",
      "- item\n\n      indented code",
      "> - ```\n>   x\n>   ```",
    ])
      expect(markdownWithTopLevelCodeBlocks(markdown)).toBe(markdown);
  });
});
