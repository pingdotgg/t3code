import { describe, expect, it } from "vite-plus/test";

import { changeRequestTermKind } from "./changeRequestTerm";

describe("changeRequestTermKind", () => {
  it.each([
    ["pull request", "pr"],
    ["merge request", "mr"],
    ["change request", "cr"],
    ["trail", "cr"],
  ] as const)("picks the %s wording", (singular, kind) => {
    expect(changeRequestTermKind({ singular })).toBe(kind);
  });
});
