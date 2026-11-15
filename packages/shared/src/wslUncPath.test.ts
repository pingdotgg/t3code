import { describe, expect, it } from "vite-plus/test";

import { parseWslUncPath } from "./wslUncPath.ts";

describe("parseWslUncPath", () => {
  it("parses wsl.localhost UNC paths into distro and POSIX path", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo")).toEqual({
      distro: "Ubuntu-22.04",
      linuxPath: "/home/josh/repo",
    });
  });

  it("rejects non-WSL paths and invalid distro names", () => {
    expect(parseWslUncPath("C:\\Users\\Josh\\repo")).toBeNull();
    expect(parseWslUncPath("\\\\wsl.localhost\\bad!name\\home")).toBeNull();
  });
});
