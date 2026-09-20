// @effect-diagnostics nodeBuiltinImport:off - Compiles the native dependency regression directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This test compiles against the host Foundation framework.
it.skipIf(NodeOS.platform() !== "darwin")(
  "registers and reads native permissions concurrently without corrupting the registry",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-permissions-test-"));
    try {
      const require = NodeModule.createRequire(import.meta.url);
      const core = NodePath.dirname(
        NodeModule.createRequire(require.resolve("expo/package.json")).resolve(
          "expo-modules-core/package.json",
        ),
      );
      const read = (relativePath: string) =>
        NodeFS.readFileSync(NodePath.join(core, relativePath), "utf8").replace(
          /^#import .*$/gm,
          "",
        );
      const source = NodePath.join(directory, "regression.m");
      NodeFS.writeFileSync(
        source,
        [
          "#import <Foundation/Foundation.h>",
          "#import <objc/runtime.h>",
          "#include <assert.h>",
          "#include <pthread.h>",
          "typedef void (^EXPromiseResolveBlock)(id result);",
          "typedef void (^EXPromiseRejectBlock)(NSString *, NSString *, NSError *);",
          "#define RCTLogWarn(...)",
          read("ios/Interfaces/Permissions/EXPermissionsInterface.h"),
          read("ios/Legacy/Services/Permissions/EXPermissionsService.h"),
          read("ios/Legacy/Services/Permissions/EXPermissionsService.m"),
          NodeFS.readFileSync(
            new URL("./fixtures/PermissionsServiceRegression.m", import.meta.url),
            "utf8",
          ),
        ].join("\n"),
      );
      const executable = NodePath.join(directory, "regression");
      NodeChildProcess.execFileSync(
        "clang",
        [
          "-fobjc-arc",
          "-fblocks",
          "-fsanitize=thread",
          "-framework",
          "Foundation",
          source,
          "-o",
          executable,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(
        NodeChildProcess.execFileSync(executable, { encoding: "utf8", timeout: 15_000 }).trim(),
      ).toBe("passed");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
