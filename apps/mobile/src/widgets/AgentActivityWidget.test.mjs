import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { getConfig } = require("expo/config");

it("embeds an Agent Activity Home Screen layout and initial data independently of Live Activities", () => {
  const projectRoot = NodePath.resolve(import.meta.dirname, "../..");
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
  const plugin = exp.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-widgets");
  const widget = plugin[1].widgets.find((entry) => entry.name === "AgentActivity");
  expect(widget.ios.initialLayout).toBeDefined();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-activity-layout-"));
  try {
    const configPath = NodePath.join(directory, "config.json");
    const outputPath = NodePath.join(directory, "registry.json");
    NodeFS.writeFileSync(
      configPath,
      JSON.stringify({ widgets: [{ name: widget.name, initialLayout: widget.ios.initialLayout }] }),
    );
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        require.resolve("expo-widgets/scripts/build-layout-registry.mjs"),
        projectRoot,
        "ios",
        outputPath,
        configPath,
      ],
      { cwd: projectRoot, stdio: "pipe" },
    );
    const { widgets } = JSON.parse(NodeFS.readFileSync(outputPath, "utf8"));
    expect(widgets.AgentActivity.layout).toContain("Tap to refresh");
    expect(widgets.AgentActivity.initialProps).toMatchObject({ activeCount: 0, activities: [] });
    const runtimePath = NodePath.join(directory, "runtime.js");
    NodeChildProcess.execFileSync(
      process.execPath,
      [require.resolve("expo-widgets/scripts/build-bundle.mjs"), projectRoot, "ios", runtimePath],
      { cwd: projectRoot, stdio: "pipe" },
    );
    const context = NodeVM.createContext({ console, process: { env: {} } });
    NodeVM.runInContext("Date.now = () => 2000", context);
    NodeVM.runInContext(NodeFS.readFileSync(runtimePath, "utf8"), context);
    context.__expoWidgetLayout = NodeVM.runInContext(`(${widgets.AgentActivity.layout})`, context);
    const props = {
      ...widgets.AgentActivity.initialProps,
      activeCount: 1,
      expiresAt: 1_000,
      activities: [
        {
          environmentId: "environment",
          threadId: "thread",
          threadTitle: "Review the task",
          projectTitle: "Project",
          status: "Waiting for input",
          phase: "waiting_for_input",
        },
      ],
    };
    for (const widgetFamily of ["systemSmall", "systemMedium", "accessoryRectangular"]) {
      const environment = { widgetFamily, colorScheme: "dark", widgetRenderingMode: "fullColor" };
      const initial = JSON.stringify(
        context.__expoWidgetRender(widgets.AgentActivity.initialProps, environment),
      );
      expect(initial).toContain("Tap to refresh");
      const active = JSON.stringify(
        context.__expoWidgetRender({ ...props, expiresAt: 3_000 }, environment),
      );
      expect(active).toContain("1 active");
      expect(active).toContain("Review the task");
      expect(active).toContain("Needs input");
      const expired = JSON.stringify(context.__expoWidgetRender(props, environment));
      expect(expired).toContain("Tap to refresh");
      expect(expired).not.toContain("Review the task");
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
