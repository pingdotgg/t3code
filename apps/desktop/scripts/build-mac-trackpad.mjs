import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The helper uses the host macOS SDK.
const platform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Dev builds target the host architecture.
const hostArch = process.arch;
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

if (platform === "darwin") {
  const targets = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (!targets) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/mac-trackpad/", import.meta.url));
  const source = NodePath.join(root, "TrackpadScroll.m");
  const output = values.output ?? NodePath.join(root, "build", values.arch, "libt3-trackpad.dylib");
  const modifiedAt = Math.max(
    NodeFS.statSync(source).mtimeMs,
    NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
  );
  if ((NodeFS.statSync(output, { throwIfNoEntry: false })?.mtimeMs ?? 0) < modifiedAt) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "clang",
          "-dynamiclib",
          "-fobjc-arc",
          "-O2",
          "-mmacosx-version-min=12.0",
          ...targets.flatMap((arch) => ["-arch", arch]),
          "-framework",
          "AppKit",
          source,
          "-o",
          temporary,
        ],
        { stdio: "inherit" },
      );
      NodeFS.renameSync(temporary, output);
    } catch (cause) {
      if (values.output) throw cause;
      console.warn(
        "Skipping the macOS trackpad monitor. Install Xcode Command Line Tools to build it.",
      );
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
}
