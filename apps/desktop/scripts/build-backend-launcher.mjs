import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The native compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation only runs on the actual macOS host.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

function compile(source, clangArchs, file) {
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
        source,
        "-o",
        file,
      ],
      { stdio: "inherit" },
    );
  } catch (cause) {
    throw new Error(
      "Building the macOS backend launcher requires Xcode Command Line Tools (xcode-select --install).",
      { cause },
    );
  }
}

if (hostPlatform === "darwin") {
  const clangArchs = { x64: ["x86_64"], arm64: ["arm64"], universal: ["x86_64", "arm64"] }[
    values.arch
  ];
  if (clangArchs === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/backend-launcher/", import.meta.url));
  const source = NodePath.resolve(root, "main.c");
  const output =
    values.output ?? NodePath.resolve(root, "build", values.arch, "t3-backend-launcher");
  const matchesArchitecture = (file) => {
    const result = NodeChildProcess.spawnSync("lipo", ["-archs", file], { encoding: "utf8" });
    const archs = result.status === 0 ? result.stdout.trim().split(/\s+/).toSorted() : [];
    return archs.join(" ") === clangArchs.toSorted().join(" ");
  };
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
        Math.max(
          NodeFS.statSync(source).mtimeMs,
          NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
        ) && matchesArchitecture(output);
  } catch {}
  if (!current) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      compile(source, clangArchs, temporary);
      if (!matchesArchitecture(temporary))
        throw new Error(`C compiler did not produce a macOS ${values.arch} executable.`);
      NodeFS.renameSync(temporary, output);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
}
