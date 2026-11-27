import { assert, describe, it } from "@effect/vitest";

import { cutLineNoteStart } from "./diffCutLines.ts";

describe("cutLineNoteStart", () => {
  it.each(["", "\r"])("finds the note without counting the line ending %j", (ending) => {
    assert.strictEqual(cutLineNoteStart(`😀ab …[1,000 more characters]${ending}`), 5);
    assert.isNull(cutLineNoteStart(`😀ab${ending}`));
  });
});
