import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const withIosControls = require("./withIosControls.cjs");
const withWidgetLogoAsset = require("./withWidgetLogoAsset.cjs");
const withWidgets = require("expo-widgets/app.plugin.js").default;

it.each(["t3code", "t3code-dev", "t3code-preview"])(
  "adds iOS controls and the T3 symbol to the Expo widget bundle using %s",
  async (scheme) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-control-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "Podfile"), 'target "T3Code" do\nend\n');
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
        modRequest: { projectRoot: root, platformProjectRoot: root, platform: "ios" },
      });
      const widgetRoot = NodePath.join(root, "ExpoWidgetsTarget");
      const index = NodeFS.readFileSync(NodePath.join(widgetRoot, "index.swift"), "utf8");
      expect(index).toContain("if #available(iOS 18.0, *)");
      expect(index).toContain("T3StartTaskControl()");
      expect(index).toContain("T3OpenAppControl()");
      expect(index).toContain("SubscriptionUsage()");
      expect(index).toContain("WidgetLiveActivity()");
      const intent = NodeFS.readFileSync(NodePath.join(root, "T3ControlIntents.swift"), "utf8");
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
