import { describe, expect, it } from "vite-plus/test";

import { windowsPowerShellPath, windowsSystem32Path } from "./windowsSystem.ts";

describe("windowsSystem32Path", () => {
  it("resolves mixed-case SystemRoot and windir from plain environment snapshots", () => {
    expect(
      windowsSystem32Path(
        { Systemroot: String.raw`D:\Windows`, WINDIR: String.raw`D:\Windows` },
        "taskkill.exe",
      ),
    ).toBe(String.raw`D:\Windows\System32\taskkill.exe`);
    expect(windowsPowerShellPath({ WINDIR: String.raw`D:\Windows` })).toBe(
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
  });

  it("prefers SystemRoot over windir regardless of casing and ignores empty values", () => {
    expect(
      windowsSystem32Path(
        { windir: String.raw`E:\Windows`, Systemroot: String.raw`D:\Windows` },
        "taskkill.exe",
      ),
    ).toBe(String.raw`D:\Windows\System32\taskkill.exe`);
    expect(
      windowsSystem32Path({ Systemroot: "", WINDIR: String.raw`D:\Windows` }, "taskkill.exe"),
    ).toBe(String.raw`D:\Windows\System32\taskkill.exe`);
  });

  it("falls back to C:\\Windows when neither variable is set", () => {
    expect(windowsSystem32Path({}, "taskkill.exe")).toBe(
      String.raw`C:\Windows\System32\taskkill.exe`,
    );
  });
});
