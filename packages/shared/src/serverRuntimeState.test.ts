import { describe, expect, it } from "vite-plus/test";

import { deriveServerRuntimeStatePath } from "./serverRuntimeState.ts";

describe("deriveServerRuntimeStatePath", () => {
  it("places runtime state under the selected state variant", () => {
    expect(
      deriveServerRuntimeStatePath({
        baseDir: "/home/user/.t3",
        variant: "userdata",
        joinPath: (...segments) => segments.join("/"),
      }),
    ).toBe("/home/user/.t3/userdata/server-runtime.json");
    expect(
      deriveServerRuntimeStatePath({
        baseDir: "C:\\Users\\user\\.t3",
        variant: "dev",
        joinPath: (...segments) => segments.join("\\"),
      }),
    ).toBe("C:\\Users\\user\\.t3\\dev\\server-runtime.json");
  });
});
