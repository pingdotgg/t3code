import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone compiler script targets the host.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone compiler script has no Effect runtime.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: {
    output: { type: "string" },
    arch: { type: "string", default: hostArch },
  },
});
if (hostPlatform === "darwin") {
  const output =
    values.output ??
    NodeURL.fileURLToPath(new URL("../resources/preview-passkeys.dylib", import.meta.url));
  const architectures = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (!architectures) throw new Error(`Unsupported Mac architecture: ${values.arch}`);
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeChildProcess.execFileSync(
    "xcrun",
    [
      "clang",
      "-dynamiclib",
      "-fobjc-arc",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-Werror",
      "-mmacosx-version-min=12.0",
      ...architectures.flatMap((arch) => ["-arch", arch]),
      "-framework",
      "AppKit",
      "-framework",
      "AuthenticationServices",
      "-framework",
      "Security",
      NodeURL.fileURLToPath(new URL("../../../native/preview-passkeys/main.m", import.meta.url)),
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
} else if (values.output) {
  throw new Error("The preview passkey bridge must be built on macOS.");
}
