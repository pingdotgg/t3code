import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation only runs on the actual macOS host.
const hostPlatform = process.platform;

// Development builds are universal so the launcher matches whichever Electron arch runs it.
const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: "universal" } },
});

if (hostPlatform === "darwin") {
  const clangArchs = { x64: ["x86_64"], arm64: ["arm64"], universal: ["x86_64", "arm64"] }[
    values.arch
  ];
  if (clangArchs === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/backend-launcher/", import.meta.url));
  const output = values.output ?? NodePath.resolve(root, "build", "t3-backend-launcher");
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  // A running backend may exec the old launcher while this rebuilds it.
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    NodeChildProcess.execFileSync(
      process.env.CC || "clang",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        // Match Electron's minimum supported macOS.
        "-mmacosx-version-min=12.0",
        ...clangArchs.flatMap((arch) => ["-arch", arch]),
        NodePath.resolve(root, "main.c"),
        "-o",
        temporary,
      ],
      { stdio: "inherit" },
    );
    NodeFS.renameSync(temporary, output);
  } catch (cause) {
    throw new Error(
      "Building the macOS backend launcher requires Xcode Command Line Tools (xcode-select --install).",
      { cause },
    );
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}
