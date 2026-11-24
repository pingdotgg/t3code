import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

const require = NodeModule.createRequire(import.meta.url);
const withAppleIntents = require("./withAppleIntents.cjs") as (
  config: Record<string, unknown>,
) => Record<string, unknown>;

describe("withAppleIntents config plugin", () => {
  it("registers NSUserActivityTypes, App Group, bridge Swift file, and Skills.skillsbundle", async () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-with-apple-intents-"));
    try {
      const iosDir = NodePath.join(tmpRoot, "ios");
      NodeFS.mkdirSync(NodePath.join(iosDir, "T3Code"), { recursive: true });

      const config = withAppleIntents({
        name: "T3 Code",
        ios: { bundleIdentifier: "com.t3tools.t3code.dev" },
      }) as {
        mods: {
          ios: {
            infoPlist: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
            dangerous: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        };
      };

      const infoResult = (await config.mods.ios.infoPlist({
        ios: { bundleIdentifier: "com.t3tools.t3code.dev" },
        modResults: { NSUserActivityTypes: ["existing.activity"] },
      })) as { modResults: Record<string, unknown> };

      expect(infoResult.modResults.NSUserActivityTypes).toEqual([
        "existing.activity",
        "com.t3tools.t3code.view-thread",
        "com.t3tools.t3code.view-project",
      ]);
      expect(infoResult.modResults.T3AppGroupIdentifier).toBe("group.com.t3tools.t3code.dev");

      const projectRoot = NodePath.resolve(import.meta.dirname, "..");
      await config.mods.ios.dangerous({
        modRequest: {
          projectRoot,
          platformProjectRoot: iosDir,
          projectName: "T3Code",
        },
        modResults: {},
      });

      const bridgeSwift = NodeFS.readFileSync(
        NodePath.join(iosDir, "T3Code", "T3AppIntentsPackageBridge.swift"),
        "utf8",
      );
      expect(bridgeSwift).toContain("struct T3MobileAppIntentsPackage: AppIntentsPackage");
      expect(bridgeSwift).toContain("T3IntentsCorePackage.self");
      expect(
        NodeFS.existsSync(
          NodePath.join(
            iosDir,
            "T3Code",
            "Skills.skillsbundle",
            "Skills",
            "start-coding-task",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
