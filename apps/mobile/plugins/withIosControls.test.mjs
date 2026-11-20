import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { IOSConfig } = require("expo/config-plugins");
const withIosControls = require("./withIosControls.cjs");
const withWidgetLogoAsset = require("./withWidgetLogoAsset.cjs");
const withWidgets = require("expo-widgets/app.plugin.js").default;

it.each(["t3code", "t3code-dev", "t3code-preview"])(
  "adds iOS controls and the T3 symbol to the Expo widget bundle using %s",
  async (scheme) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-control-"));
    try {
      const iosRoot = NodePath.join(root, "ios");
      const projectPath = NodePath.join(iosRoot, "HelloWorld.xcodeproj", "project.pbxproj");
      NodeFS.mkdirSync(NodePath.dirname(projectPath), { recursive: true });
      NodeFS.writeFileSync(
        projectPath,
        NodeChildProcess.execFileSync("tar", [
          "-xzOf",
          NodePath.join(NodePath.dirname(require.resolve("expo/package.json")), "template.tgz"),
          "package/ios/HelloWorld.xcodeproj/project.pbxproj",
        ]),
      );
      NodeFS.writeFileSync(NodePath.join(iosRoot, "Podfile"), 'target "T3Code" do\nend\n');
      NodeFS.mkdirSync(NodePath.join(root, "assets/widget"), { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(import.meta.dirname, "../assets/widget/T3Mark.svg"),
        NodePath.join(root, "assets/widget/T3Mark.svg"),
      );
      const config = withWidgets(
        withIosControls(
          withWidgetLogoAsset({
            name: "T3 Code",
            slug: "t3-code",
            scheme,
            _internal: { projectRoot: root },
            ios: { bundleIdentifier: "com.t3tools.t3code" },
          }),
        ),
        {
          widgets: [
            {
              name: "SubscriptionUsage",
              displayName: "Subscription usage",
              description: "Usage",
              ios: { supportedFamilies: ["systemSmall"] },
            },
          ],
        },
      );
      await config.mods.ios.dangerous({
        ...config,
        modRequest: { projectRoot: root, platformProjectRoot: iosRoot, platform: "ios" },
      });
      const generated = await config.mods.ios.xcodeproj({
        ...config,
        modResults: IOSConfig.XcodeUtils.getPbxproj(root),
        modRequest: { projectRoot: root, platformProjectRoot: iosRoot, platform: "ios" },
      });
      NodeFS.writeFileSync(projectPath, generated.modResults.writeSync());
      const project = IOSConfig.XcodeUtils.getPbxproj(root);
      const [widgetTargetId, widgetTarget] = Object.entries(project.pbxNativeTargetSection()).find(
        ([key, target]) => !key.endsWith("_comment") && target.name === "ExpoWidgetsTarget",
      );
      const buildFiles = project.pbxBuildFileSection();
      const fileReferences = project.pbxFileReferenceSection();
      const sourcePaths = (targetId) =>
        project
          .pbxSourcesBuildPhaseObj(targetId)
          .files.map(({ value }) =>
            fileReferences[buildFiles[value].fileRef].path.replaceAll('"', ""),
          );
      expect(sourcePaths(project.getFirstTarget().uuid)).toContain("T3ControlIntents.swift");
      expect(sourcePaths(widgetTargetId)).toEqual(
        expect.arrayContaining([
          "ExpoWidgetsTarget/T3ControlIntents.swift",
          "ExpoWidgetsTarget/T3StartTaskControl.swift",
          "ExpoWidgetsTarget/T3OpenAppControl.swift",
        ]),
      );
      const configurations = project.pbxXCConfigurationList()[widgetTarget.buildConfigurationList];
      for (const { value } of configurations.buildConfigurations) {
        expect(
          project.pbxXCBuildConfigurationSection()[value].buildSettings
            .SWIFT_ACTIVE_COMPILATION_CONDITIONS,
        ).toContain("T3_WIDGET_EXTENSION");
      }
      const widgetRoot = NodePath.join(iosRoot, "ExpoWidgetsTarget");
      const index = NodeFS.readFileSync(NodePath.join(widgetRoot, "index.swift"), "utf8");
      expect(index).toContain("if #available(iOS 18.0, *)");
      expect(index).toContain("T3StartTaskControl()");
      expect(index).toContain("T3OpenAppControl()");
      expect(index).toContain("SubscriptionUsage()");
      expect(index).toContain("WidgetLiveActivity()");
      const intent = NodeFS.readFileSync(NodePath.join(iosRoot, "T3ControlIntents.swift"), "utf8");
      expect(intent).toContain(`"${scheme}://new"`);
      expect(NodeFS.readFileSync(NodePath.join(widgetRoot, "T3ControlIntents.swift"), "utf8")).toBe(
        intent,
      );
      expect(
        NodeFS.readFileSync(NodePath.join(widgetRoot, "T3StartTaskControl.swift"), "utf8"),
      ).toContain("ControlWidgetButton(action: T3StartTaskIntent())");
      expect(
        NodeFS.readFileSync(NodePath.join(widgetRoot, "T3OpenAppControl.swift"), "utf8"),
      ).toContain("ControlWidgetButton(action: T3OpenAppIntent())");
      const symbolSet = NodePath.join(widgetRoot, "Assets.xcassets/T3ControlMark.symbolset");
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(symbolSet, "Contents.json"), "utf8")),
      ).toMatchObject({
        symbols: [{ filename: "T3ControlMark.svg", idiom: "universal" }],
      });
      expect(NodeFS.readFileSync(NodePath.join(symbolSet, "T3ControlMark.svg"), "utf8")).toContain(
        'id="Regular-S"',
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
