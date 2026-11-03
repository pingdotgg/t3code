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
      freshUntil: 3_000,
      source: "snapshot",
      baseUrl: "t3code-dev:///",
      activities: [
        {
          environmentId: "environment",
          threadId: "thread",
          threadTitle: "Review the task",
          projectTitle: "Project",
          status: "Input",
          phase: "waiting_for_input",
          deepLink: "/threads/environment/mcp%3Atask",
        },
      ],
    };
    for (const widgetFamily of widget.ios.supportedFamilies) {
      const environment = { widgetFamily, colorScheme: "dark", widgetRenderingMode: "fullColor" };
      const initial = JSON.stringify(
        context.__expoWidgetRender(widgets.AgentActivity.initialProps, environment),
      );
      expect(initial).toContain("Open T3 Code");
      const active = JSON.stringify(context.__expoWidgetRender(props, environment));
      expect(active).toContain("1 active");
      expect(active).toContain("Review the task");
      expect(active).toContain("Input");
      expect(active).toContain("t3code-dev:///threads/environment/mcp%3Atask");
      for (const [source, subtitle] of [
        ["loading", "Loading agents…"],
        ["signed-out", "Sign in to T3 Connect to see agents"],
        ["unavailable", "Couldn't reach T3 Connect"],
        ["snapshot", "No active agents"],
      ]) {
        const empty = JSON.stringify(
          context.__expoWidgetRender(
            { activeCount: 0, activities: [], source, subtitle },
            environment,
          ),
        );
        expect(empty).toContain(subtitle);
        expect(empty).not.toContain("Review the task");
      }
      const expired = JSON.stringify(
        context.__expoWidgetRender({ ...props, freshUntil: 1_000 }, environment),
      );
      expect(expired).toContain("Out of date");
      expect(expired).not.toContain("Input");
      const scheduled = JSON.stringify(
        context.__expoWidgetRender(props, { ...environment, timestamp: 3_000 }),
      );
      expect(scheduled).toContain("Out of date");
      expect(scheduled).not.toContain("Input");
    }
    const aggregate = {
      ...props,
      activeCount: 10,
      activities: Array.from({ length: 5 }, (_, index) => ({
        ...props.activities[0],
        threadId: `thread-${index}`,
        threadTitle: `Relay task ${index + 1}`,
        phase: "running",
        status: "Working",
      })),
    };
    for (const [widgetFamily, dynamicTypeSize, visibleRows] of [
      ["systemMedium", "large", 2],
      ["systemMedium", "xxLarge", 2],
      ["systemMedium", "xxxLarge", 1],
      ["systemMedium", "accessibility5", 1],
      ["systemLarge", "large", 5],
      ["systemLarge", "xLarge", 4],
      ["systemLarge", "xxxLarge", 3],
      ["systemLarge", "accessibility5", 2],
    ]) {
      const aggregateLayout = JSON.stringify(
        context.__expoWidgetRender(aggregate, {
          widgetFamily,
          dynamicTypeSize,
          colorScheme: "light",
          widgetRenderingMode: "fullColor",
        }),
      );
      expect(aggregateLayout).toContain(`Relay task ${visibleRows}`);
      if (visibleRows < 5) {
        expect(aggregateLayout).not.toContain(`Relay task ${visibleRows + 1}`);
      }
      expect(aggregateLayout).toContain("10 active");
      const waitingLayout = JSON.stringify(
        context.__expoWidgetRender(
          {
            ...aggregate,
            activities: aggregate.activities.map((row, index) =>
              index === 0 ? { ...row, phase: "stale", status: "Waiting" } : row,
            ),
          },
          { widgetFamily, dynamicTypeSize, colorScheme: "light", widgetRenderingMode: "fullColor" },
        ),
      );
      expect(waitingLayout).toContain("Waiting");
      expect(waitingLayout).toContain("10 active");
      expect(waitingLayout).not.toContain("Out of date");
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
