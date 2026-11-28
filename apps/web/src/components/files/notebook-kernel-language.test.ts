import { expect, it } from "vite-plus/test";

import { openNotebook } from "./extendedDocumentPreview";

const malformed = { toString: null };

it.each([
  [{ kernelspec: { name: "python3", display_name: "Python 3" } }, "python"],
  [{ kernelspec: { name: "Python3" } }, "python"],
  [{ kernelspec: { name: malformed } }, "text"],
  [{ language_info: { name: malformed }, kernelspec: { language: "r" } }, "r"],
  [{ kernelspec: { name: "python3", language: malformed } }, "python"],
])("previews a notebook with metadata %j as %s", (metadata, language) => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata,
    cells: [
      {
        id: "example",
        cell_type: "code",
        metadata: {},
        source: ["for value in range(3):\n", "    print(value)"],
        execution_count: null,
        outputs: [],
      },
    ],
  };
  const preview = openNotebook(new TextEncoder().encode(JSON.stringify(notebook)).buffer);
  if (preview.type !== "notebook") throw new Error("Expected a notebook preview");
  expect(preview.language).toBe(language);
});
