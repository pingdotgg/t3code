import { describe, expect, it } from "vite-plus/test";

import {
  ansiEncodingForCodePage,
  parseCodePageRegistryOutput,
  windowsRegistryTool,
} from "./windowsCodePage.ts";

describe("parseCodePageRegistryOutput", () => {
  it("reads the ACP value from `reg query` output", () => {
    expect(
      parseCodePageRegistryOutput(
        [
          "",
          "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
          "    ACP    REG_SZ    1252",
          "",
        ].join("\r\n"),
      ),
    ).toBe(1252);
  });

  it("returns null when the value or the query is missing", () => {
    expect(parseCodePageRegistryOutput("")).toBeNull();
    expect(
      parseCodePageRegistryOutput(
        "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      ),
    ).toBeNull();
    expect(
      parseCodePageRegistryOutput(
        "ERROR: The system was unable to find the specified registry key or value.",
      ),
    ).toBeNull();
  });
});

describe("windowsRegistryTool", () => {
  it("resolves reg.exe from the Windows install instead of the working directory", () => {
    expect(windowsRegistryTool({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\reg.exe",
    );
    expect(windowsRegistryTool({})).toBe("C:\\Windows\\System32\\reg.exe");
  });
});

describe("ansiEncodingForCodePage", () => {
  it("maps single and double byte code pages to TextDecoder labels", () => {
    expect(ansiEncodingForCodePage(1252)).toBe("windows-1252");
    expect(ansiEncodingForCodePage(1251)).toBe("windows-1251");
    expect(ansiEncodingForCodePage(1250)).toBe("windows-1250");
    expect(ansiEncodingForCodePage(936)).toBe("gbk");
    expect(ansiEncodingForCodePage(932)).toBe("shift_jis");
    expect(ansiEncodingForCodePage(950)).toBe("big5");
    expect(ansiEncodingForCodePage(54936)).toBe("gb18030");
  });

  it("leaves UTF-8 and unknown code pages undecoded", () => {
    expect(ansiEncodingForCodePage(65001)).toBeNull();
    expect(ansiEncodingForCodePage(42)).toBeNull();
  });
});
