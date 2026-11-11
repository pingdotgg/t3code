import { describe, expect, it } from "vite-plus/test";
import { markdownWithTopLevelCodeBlocks, parseMarkdownDocument } from "./markdownDocument";

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

  it("keeps the count and the paragraph break when the next item's fence is on its marker line", () => {
    const ordered = markdownWithTopLevelCodeBlocks(
      "1. ```sh\n   echo a\n   ```\n1. ```sh\n   echo b\n   ```\n1. end",
    );
    expect(ordered).toBe("1.\n\n```sh\necho a\n```\n\n2.\n\n```sh\necho b\n```\n\n3. end");
    expect(
      parseMarkdownDocument(ordered).children.map((node) =>
        node.type === "list" ? node.start : node.type,
      ),
    ).toEqual([1, "code", 2, "code", 3]);
    expect(
      markdownWithTopLevelCodeBlocks("- a\n  ```\n  x\n  ```\n  tail\n- ```sh\n  y\n  ```"),
    ).toBe("- a\n\n```\nx\n```\n\ntail\n\n-\n\n```sh\ny\n```\n\n");
  });

  it("leaves unclosed, nested and top-level fences alone", () => {
    for (const markdown of [
      "1. Run this:\n   ```bash\n   cd /tmp\n",
      "1. Run this:\n\n   ```sh\n   echo hello\n\n",
      "- ```\n- ```\n",
      "- a\n  ```sh\n  ls\n\nAfterword",
      "- a\n  - b\n    ```\n    x\n    ```",
      "1. Run\n   ```\n   x\n   ```\n   1. child\n      ```\n      y\n      ```\n1. next",
      "```sh\nls\n```\n- item",
      "> - ```\n>   x\n>   ```",
    ])
      expect(markdownWithTopLevelCodeBlocks(markdown)).toBe(markdown);
  });
});
