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
    expect(
      markdownWithTopLevelCodeBlocks("- ```sh\n  ls\n  ```\n- next\n  ~~~\n  pwd\n  ~~~"),
    ).toBe("-\n\n```sh\nls\n```\n\n- next\n\n~~~\npwd\n~~~\n\n");
  });

  it("leaves unclosed, nested and top-level fences alone", () => {
    for (const markdown of [
      "1. Run this:\n   ```bash\n   cd /tmp\n",
      "1. Run this:\n\n   ```sh\n   echo hello\n\n",
      "- ```\n- ```\n",
      "- a\n  ```sh\n  ls\n\nAfterword",
      "- a\n  - b\n    ```\n    x\n    ```",
      "```sh\nls\n```\n- item",
      "> - ```\n>   x\n>   ```",
    ])
      expect(markdownWithTopLevelCodeBlocks(markdown)).toBe(markdown);
  });
});
