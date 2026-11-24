import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Xcode targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- AppIntents & ExtensionKit exist only in the macOS SDK.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: {
    outputDir: { type: "string" },
    arch: { type: "string", default: hostArch },
  },
});

// Packaging passes --outputDir and must fail loudly if the 27.3 native artifacts cannot be built.
const required = values.outputDir !== undefined;

function newestMtimeMs(targetPath) {
  const stat = NodeFS.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of NodeFS.readdirSync(targetPath)) {
    if (entry === "build" || entry === ".build" || entry === ".swiftpm") continue;
    const mtime = newestMtimeMs(NodePath.join(targetPath, entry));
    if (mtime > max) max = mtime;
  }
  return max;
}

function copyTree(src, dest) {
  NodeFS.rmSync(dest, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
  NodeFS.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

if (hostPlatform !== "darwin") {
  if (required) throw new Error("Apple Intents macOS artifacts can only be built on macOS.");
} else {
  const xcodeArchs = { arm64: "arm64", x64: "x86_64", universal: "arm64 x86_64" }[values.arch];
  if (xcodeArchs === undefined) {
    throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  }

  const root = NodeURL.fileURLToPath(new URL("../../../native/apple-intents/", import.meta.url));
  const macosDir = NodePath.join(root, "macos");
  const projectPath = NodePath.join(macosDir, "T3AppleIntentsMac.xcodeproj");
  const outputDir = values.outputDir ?? NodePath.join(macosDir, "build", values.arch);

  const outHostDylib = NodePath.join(outputDir, "host", "libT3AppIntentsHost.dylib");
  const outFramework = NodePath.join(outputDir, "bundles", "T3IntentsCore.framework");
  const outExtension = NodePath.join(outputDir, "bundles", "T3AppIntentsExtension.appex");
  const devFrameworkMirror = NodePath.join(outputDir, "host", "T3IntentsCore.framework");

  let current = false;
  try {
    const oldestOutput = Math.min(
      NodeFS.statSync(outHostDylib).mtimeMs,
      NodeFS.statSync(outFramework).mtimeMs,
      NodeFS.statSync(outExtension).mtimeMs,
    );
    const newestInput = Math.max(
      newestMtimeMs(NodePath.join(root, "Sources")),
      newestMtimeMs(NodePath.join(root, "Skills.skillsbundle")),
      newestMtimeMs(NodePath.join(macosDir, "Extension")),
      newestMtimeMs(NodePath.join(macosDir, "Host")),
      newestMtimeMs(NodePath.join(macosDir, "Framework")),
      NodeFS.statSync(NodePath.join(projectPath, "project.pbxproj")).mtimeMs,
      NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
    );
    current = oldestOutput >= newestInput;
  } catch {}

  if (!current) {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-apple-intents-build-"));
    try {
      const symRoot = NodePath.join(tmpRoot, "Products");
      const objRoot = NodePath.join(tmpRoot, "Intermediates");
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "xcodebuild",
          "-project",
          projectPath,
          "-alltargets",
          "-configuration",
          "Release",
          `SYMROOT=${symRoot}`,
          `OBJROOT=${objRoot}`,
          `ARCHS=${xcodeArchs}`,
          `ONLY_ACTIVE_ARCH=${values.arch === "universal" ? "NO" : "YES"}`,
          "CODE_SIGNING_ALLOWED=NO",
        ],
        { stdio: "inherit" },
      );

      const releaseDir = NodePath.join(symRoot, "Release");
      const builtFramework = NodePath.join(releaseDir, "T3IntentsCore.framework");
      const builtExtension = NodePath.join(releaseDir, "T3AppIntentsExtension.appex");
      const builtDylib = NodePath.join(releaseDir, "libT3AppIntentsHost.dylib");

      // Validate metadata & compiled skills with Apple's 27.3 analyzer against the final app layout.
      const verifyApp = NodePath.join(tmpRoot, "VerifyT3.app");
      copyTree(
        builtFramework,
        NodePath.join(verifyApp, "Contents", "Frameworks", "T3IntentsCore.framework"),
      );
      copyTree(
        builtExtension,
        NodePath.join(verifyApp, "Contents", "Extensions", "T3AppIntentsExtension.appex"),
      );
      NodeFS.writeFileSync(
        NodePath.join(verifyApp, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.t3tools.t3code</string>
<key>CFBundleName</key><string>T3 Code</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`,
      );
      const analysisRaw = NodeChildProcess.execFileSync(
        "xcrun",
        ["sirimetadataanalyzer", verifyApp, "--format", "json"],
        { encoding: "utf8" },
      );
      const analysis = JSON.parse(analysisRaw);
      if (
        !analysis?.summary ||
        analysis.summary.toolCount < 1 ||
        analysis.summary.findingCount > 0
      ) {
        throw new Error(
          `sirimetadataanalyzer reported unexpected findings: ${JSON.stringify(analysis.findings ?? analysis)}`,
        );
      }

      copyTree(builtFramework, outFramework);
      copyTree(builtExtension, outExtension);
      NodeFS.mkdirSync(NodePath.dirname(outHostDylib), { recursive: true });
      NodeFS.copyFileSync(builtDylib, outHostDylib);
      // Local dev loads libT3AppIntentsHost.dylib from outputDir/host with @loader_path rpath.
      if (!required) {
        copyTree(builtFramework, devFrameworkMirror);
      } else {
        NodeFS.rmSync(devFrameworkMirror, { recursive: true, force: true });
      }
    } catch (cause) {
      if (required) {
        throw new Error(
          "Building the macOS Apple Intents extension requires Xcode 27.3 or later.",
          { cause },
        );
      }
      console.warn(
        "Skipping macOS Apple Intents build (needs Xcode 27.3 or later); Siri & Spotlight intents are unavailable in this dev build.",
      );
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}
