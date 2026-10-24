import { describe, expect, it } from "vite-plus/test";

import { detectShellProfiles } from "./ShellProfiles.ts";

const detectWindows = (
  existing: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
): ReadonlyArray<string> => {
  const files = new Set(existing.map((file) => file.toLowerCase()));
  return detectShellProfiles({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ...env },
    fileExists: (file) => files.has(file.toLowerCase()),
    etcShells: null,
  }).map((profile) => profile.id);
};

describe("detectShellProfiles", () => {
  it("detects Git Bash in Program Files", () => {
    const profiles = detectShellProfiles({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      fileExists: (file) => file === "C:\\Program Files\\Git\\bin\\bash.exe",
      etcShells: null,
    });
    expect(profiles).toEqual([
      {
        id: "bash",
        label: "Git Bash",
        command: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["--login", "-i"],
      },
    ]);
  });

  it("derives Git Bash from git.exe on PATH", () => {
    expect(
      detectWindows(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"], {
        PATH: "C:\\Other;D:\\Tools\\Git\\cmd",
      }),
    ).toEqual(["bash"]);
    expect(
      detectWindows(["D:\\Tools\\Git\\mingw64\\bin\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"], {
        Path: "D:\\Tools\\Git\\mingw64\\bin",
      }),
    ).toEqual(["bash"]);
  });

  it("omits shells that are not installed and orders the rest", () => {
    expect(detectWindows([])).toEqual([]);
    expect(
      detectWindows([
        "C:\\Windows\\System32\\cmd.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ]),
    ).toEqual(["pwsh", "powershell", "cmd"]);
  });

  it("parses /etc/shells, skipping comments, missing and duplicate entries", () => {
    const present = new Set(["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/sbin/nologin"]);
    const profiles = detectShellProfiles({
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
      fileExists: (file) => present.has(file),
      etcShells: [
        "# valid login shells",
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/bash",
        "/bin/fish",
        "/usr/sbin/nologin",
        "",
      ].join("\n"),
    });
    expect(profiles).toEqual([
      { id: "zsh", label: "zsh", command: "/bin/zsh", args: ["-o", "nopromptsp"] },
      { id: "bash", label: "bash", command: "/bin/bash", args: [] },
    ]);
  });

  it("falls back to $SHELL when /etc/shells is unavailable", () => {
    expect(
      detectShellProfiles({
        platform: "darwin",
        env: { SHELL: "/bin/zsh" },
        fileExists: () => true,
        etcShells: null,
      }).map((profile) => profile.id),
    ).toEqual(["zsh"]);
  });
});
