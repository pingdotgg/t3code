import { expect, it } from "vite-plus/test";
import { markdownPlainText } from "./markdownPlainText.ts";

it("keeps paragraphs, lists, links and code readable without Markdown syntax", () => {
  expect(
    markdownPlainText(`# Complete

Fixed **notifications** and [tests](https://example.test).

- Uses \`finalAnswer\`
- Keeps paragraphs

3. Review
4. Ship

> Ready &amp; checked.

\`\`\`ts
const done = true;
\`\`\`

![Screenshot](image.png)
`),
  ).toBe(`Complete

Fixed notifications and tests.

• Uses finalAnswer
• Keeps paragraphs

3. Review
4. Ship

Ready & checked.

const done = true;

Screenshot`);
  expect(markdownPlainText("<!-- no answer -->\n\n---")).toBe("");
});
