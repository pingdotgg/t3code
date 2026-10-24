import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (HostProcess.Platform.defaultValue() !== "darwin") {
  throw new Error(
    "Native markdown source tests require macOS Foundation and the Apple clang toolchain.",
  );
}
const [dependencyPathOrMode, explicitMode, ...extraArguments] = process.argv.slice(2);
const isMode = (argument) => ["cache", "coordinator"].includes(argument);
const modeOnly = isMode(dependencyPathOrMode);
const mode = modeOnly ? dependencyPathOrMode : explicitMode;
if (
  extraArguments.length > 0 ||
  (modeOnly && explicitMode !== undefined) ||
  (mode !== undefined && !isMode(mode))
) {
  throw new Error(
    "Usage: node scripts/test-enriched-markdown-native.mjs [dependency-path] [cache|coordinator]",
  );
}

// Foundation-only source harness: no simulator, app build, UIKit, or React Native runtime.
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const dependency = NodeFS.realpathSync(
  dependencyPathOrMode && !modeOnly
    ? NodePath.resolve(dependencyPathOrMode)
    : NodePath.join(here, "../node_modules/react-native-enriched-markdown"),
);
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-markdown-native-"));
try {
  const cache = NodeFS.readFileSync(
    NodePath.join(dependency, "ios/internals/MeasurementCache.h"),
    "utf8",
  );
  const namespace = cache.indexOf("namespace facebook::react {");
  const propsHelpers = cache.indexOf("template <typename StyleStruct>");
  const cacheClass = cache.indexOf("class MeasurementCache {");
  if (namespace < 0 || propsHelpers <= namespace || cacheClass <= propsHelpers)
    throw new Error("MeasurementCache layout changed; update the harness extraction");
  // Compile the actual key/hash/cache, omitting only the unrelated React prop adapters.
  NodeFS.writeFileSync(
    NodePath.join(temporary, "MeasurementCacheUnderTest.h"),
    "#include <CoreGraphics/CGBase.h>\n#include <list>\n#include <mutex>\n#include <string>\n#include <tuple>\n#include <unordered_map>\n" +
      cache.slice(namespace, propsHelpers) +
      cache.slice(cacheClass),
  );
  const executable = NodePath.join(temporary, "markdown-native-tests");
  NodeChildProcess.execFileSync(
    "clang++",
    [
      "-std=c++20",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      "-I",
      temporary,
      "-I",
      NodePath.join(dependency, "ios/utils"),
      NodePath.join(here, "enriched-markdown-native-tests.mm"),
      "-o",
      executable,
    ],
    { stdio: "inherit" },
  );
  NodeChildProcess.execFileSync(executable, mode ? [mode] : [], { stdio: "inherit" });
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
