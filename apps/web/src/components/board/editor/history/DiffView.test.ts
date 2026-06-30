import { describe, expect, it } from "vite-plus/test";

import { diffCanonicalJson } from "./DiffView";

describe("diffCanonicalJson", () => {
  it("returns no lines for identical canonical JSON", () => {
    expect(
      diffCanonicalJson('{\n  "name": "Delivery"\n}\n', '{\n  "name": "Delivery"\n}\n'),
    ).toEqual([]);
  });

  it("marks removed and added lines between version and current JSON", () => {
    expect(
      diffCanonicalJson('{\n  "name": "Delivery v1"\n}\n', '{\n  "name": "Delivery"\n}\n'),
    ).toEqual([
      { kind: "context", text: "{" },
      { kind: "removed", text: '  "name": "Delivery v1"' },
      { kind: "added", text: '  "name": "Delivery"' },
      { kind: "context", text: "}" },
    ]);
  });
});
