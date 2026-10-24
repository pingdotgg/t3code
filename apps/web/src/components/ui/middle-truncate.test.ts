import { describe, expect, it } from "vite-plus/test";

import { splitForMiddleTruncate } from "./middle-truncate";

describe("splitForMiddleTruncate", () => {
  it("keeps the last posix path segment with its separator", () => {
    expect(splitForMiddleTruncate("/usr/local/bin/zsh")).toEqual({
      head: "/usr/local/bin",
      tail: "/zsh",
    });
  });

  it("keeps the last windows path segment with its separator", () => {
    expect(
      splitForMiddleTruncate(
        "C:\\Users\\Arafa\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe",
      ),
    ).toEqual({
      head: "C:\\Users\\Arafa\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe",
      tail: "\\pwsh.exe",
    });
  });
});
