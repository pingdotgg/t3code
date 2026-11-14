import { expect, it } from "vite-plus/test";

import { codeLanguageEntry, languageOfInfoString } from "./composer-code-languages";

it("recognizes plain-text fence info strings without treating metadata as the language", () => {
  const entries = ["Text", "TEXT", "plaintext", "txt"].map((language) =>
    codeLanguageEntry(languageOfInfoString(` ${language} title=notes.txt`)),
  );

  expect(entries).toEqual(Array.from({ length: 4 }, () => ({ id: "", label: "Plain text" })));
});
