// @effect-diagnostics nodeBuiltinImport:off - Compiles and runs the native dependency regression directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This native integration test uses the host Swift compiler.
describe.skipIf(NodeOS.platform() !== "darwin")(
  "NotificationCenterManager native concurrency",
  () => {
    let directory: string;
    let executable: string;

    beforeAll(() => {
      directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-notifications-test-"));
      executable = NodePath.join(directory, "notification-regression");
      const source = NodeFS.readFileSync(
        new URL(
          "../node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationCenterManager.swift",
          import.meta.url,
        ),
        "utf8",
      );
      const manager = NodePath.join(directory, "NotificationCenterManager.swift");
      NodeFS.writeFileSync(
        manager,
        source.replace(/^import (ExpoModulesCore|UserNotifications)\n/gm, ""),
      );
      NodeChildProcess.execFileSync(
        "swiftc",
        [
          "-swift-version",
          "5",
          "-sanitize=thread",
          manager,
          NodeURL.fileURLToPath(
            new URL("./fixtures/NotificationCenterManagerRegression.swift", import.meta.url),
          ),
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
      ["reentrant", "allows callbacks to replace delegates without deadlocking"],
      ["handoff", "delivers responses to delegates registering during delivery"],
      ["pending", "retains new responses received while replaying pending responses"],
      ["concurrent", "registers, removes, and broadcasts concurrently without data races"],
    ])("%s: %s", (name) => {
      const output = NodeChildProcess.execFileSync(executable, [name], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(output.trim()).toBe("passed");
    });
  },
);
