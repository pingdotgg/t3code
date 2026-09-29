import { describe, expect, it } from "vite-plus/test";

import { fileContentRevision } from "./fileContentRevision";

describe("fileContentRevision", () => {
  it("changes for same-length edits", () => {
    expect(fileContentRevision("nodeVersion")).not.toBe(fileContentRevision("nodeVeasdrs"));
  });
});
