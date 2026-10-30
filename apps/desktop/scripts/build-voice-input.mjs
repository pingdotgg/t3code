import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const { platform, arch } = process;
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: arch } },
});
if (platform === "darwin") {
  const root = NodeURL.fileURLToPath(new URL("../../../native/voice-input/", import.meta.url));
  const output = values.output ?? NodePath.resolve(root, "target", values.arch, "t3-voice-input");
  const targets = values.arch === "universal" ? ["arm64", "x64"] : [values.arch];
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  for (const target of targets) {
    const cpu = { arm64: "arm64", x64: "x86_64" }[target];
    if (!cpu) throw new Error(`Unsupported macOS architecture: ${target}`);
    NodeChildProcess.execFileSync(
      "xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-O",
        "-target",
        `${cpu}-apple-macos13.0`,
        NodePath.resolve(root, "main.swift"),
        "-o",
        targets.length === 1 ? output : `${output}.${target}`,
      ],
      { stdio: "inherit" },
    );
  }
  if (targets.length > 1)
    NodeChildProcess.execFileSync(
      "lipo",
      ["-create", ...targets.map((target) => `${output}.${target}`), "-output", output],
      { stdio: "inherit" },
    );
  if (targets.length > 1) for (const target of targets) NodeFS.rmSync(`${output}.${target}`);
}
