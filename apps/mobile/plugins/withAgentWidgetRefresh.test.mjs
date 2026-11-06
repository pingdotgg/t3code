import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = new URL("./withAgentWidgetRefresh.cjs", import.meta.url);
const template = `StaticConfiguration(kind: name, provider: WidgetsTimelineProvider(name: name)) { entry in
      WidgetsEntryView(entry: entry)
    }
    .configurationDisplayName("Agent Activity")`;

function setup(source) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-widget-generation-"));
  const target = NodePath.join(root, "ExpoWidgetsTarget");
  NodeFS.mkdirSync(target);
  for (const name of ["ExpoWidgetsTarget.entitlements", "Info.plist"])
    NodeFS.writeFileSync(NodePath.join(target, name), "<plist><dict></dict></plist>");
  const widget = NodePath.join(target, "AgentActivity.swift");
  NodeFS.writeFileSync(widget, source);
  let transform;
  const pluginModule = { exports: {} };
  NodeVM.runInNewContext(NodeFS.readFileSync(plugin, "utf8"), {
    module: pluginModule,
    __dirname: NodePath.dirname(NodeURL.fileURLToPath(plugin)),
    require(name) {
      if (name !== "expo/config-plugins") return require(name);
      return {
        withDangerousMod(config, [, callback]) {
          transform = callback;
          return config;
        },
        withXcodeProject: (config) => config,
      };
    },
  });
  const config = pluginModule.exports({
    ios: { bundleIdentifier: "com.example.widget" },
    extra: { appVariant: "development" },
  });
  return {
    run: () => transform({ ...config, modRequest: { platformProjectRoot: root } }),
    read: () => NodeFS.readFileSync(widget, "utf8"),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it.each(["WidgetsEntryView(entry: entry)", "    .configurationDisplayName"])(
  "rejects a generated template missing %s",
  (marker) => {
    const source = template.replace(marker, "changed-template");
    using test = setup(source);
    expect(test.run).toThrow("AgentActivity widget generation changed");
    expect(test.read()).toBe(source);
  },
);

it("installs the provider, ownership guard and push handler in the supported template", () => {
  using test = setup(template);
  test.run();
  expect(test.read()).toContain("provider: AgentWidgetTimelineProvider()");
  expect(test.read()).toContain("AgentWidgetEntryView(entry: entry)");
  expect(test.read()).toContain(".agentWidgetPushHandler()\n    .configurationDisplayName");
});
