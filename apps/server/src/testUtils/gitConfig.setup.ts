// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Git for Windows installs with core.autocrlf=true, which checks committed LF
// files out as CRLF and breaks every byte-exact content assertion; a signing
// key or a non-default init branch on the developer's machine breaks fixtures
// the same way. Set as environment so each git child the driver spawns sees it
// without touching the fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

const existing = Number(process.env.GIT_CONFIG_COUNT ?? "0");
process.env.GIT_CONFIG_COUNT = String(existing + entries.length);
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${existing + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${existing + index}`] = value;
});

// Without Homebrew git, macOS resolves `git` to /usr/bin/git, an xcrun shim that costs
// about 8 ms per spawn against 3 ms for the real binary. Git-heavy files such as
// GitVcsDriverCore.test.ts and GitManager.test.ts run twice as fast with the real one.
if (HostProcess.Platform.defaultValue() === "darwin") {
  const gitOnPath = (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((dir) => NodePath.join(dir, "git"))
    .find((candidate) => NodeFS.existsSync(candidate));
  if (gitOnPath === "/usr/bin/git") {
    try {
      const realGit = NodeChildProcess.execFileSync("xcrun", ["-f", "git"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (NodePath.isAbsolute(realGit)) {
        process.env.PATH = `${NodePath.dirname(realGit)}${NodePath.delimiter}${process.env.PATH}`;
      }
    } catch {}
  }
}
