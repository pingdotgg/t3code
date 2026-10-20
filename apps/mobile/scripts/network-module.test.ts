// @effect-diagnostics nodeBuiltinImport:off - Compiles and runs the native dependency regression directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This native integration test uses the host Swift compiler.
describe.skipIf(NodeOS.platform() !== "darwin")("NetworkModule native path handoff", () => {
  let directory: string;
  let executable: string;

  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-network-test-"));
    executable = NodePath.join(directory, "network-regression");
    const source = NodeFS.readFileSync(
      new URL("../node_modules/expo-network/ios/NetworkModule.swift", import.meta.url),
      "utf8",
    );
    // Compile the dependency's query and conversion methods, replacing only
    // NWPathMonitor so we can deliver updates during and after cancellation.
    const start = source.indexOf("  private func getNetworkPathAsync()");
    if (start === -1) throw new Error("NetworkModule query implementation not found");
    const methods = source
      .slice(start, source.lastIndexOf("\n}"))
      .replace("private func getNetworkStateAsync", "func getNetworkStateAsync");
    const module = NodePath.join(directory, "NetworkModule.swift");
    NodeFS.writeFileSync(
      module,
      `import Foundation\nfinal class NetworkModule {\n  private let monitorQueue = DispatchQueue.global(qos: .default)\n${methods}\n}\n`,
    );
    const types = NodePath.join(directory, "NetworkType.swift");
    NodeFS.writeFileSync(
      types,
      NodeFS.readFileSync(
        new URL("../node_modules/expo-network/ios/NetworkType.swift", import.meta.url),
        "utf8",
      ).replace(/^import Network\n/m, ""),
    );
    NodeChildProcess.execFileSync(
      "swiftc",
      [
        "-swift-version",
        "5",
        "-sanitize=thread",
        module,
        types,
        NodeURL.fileURLToPath(new URL("./fixtures/NetworkModuleRegression.swift", import.meta.url)),
        "-o",
        executable,
      ],
      { timeout: 30_000, encoding: "utf8" },
    );
  });

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ["first", "keeps the first path when several updates arrive before the query resumes"],
    ["offline", "reports a disconnected path"],
    ["concurrent", "reads paths during overlapping queries and late callbacks without data races"],
  ])("%s: %s", (name) => {
    expect(
      NodeChildProcess.execFileSync(executable, [name], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, TSAN_OPTIONS: "halt_on_error=1" },
      }).trim(),
    ).toBe("passed");
  });
});
