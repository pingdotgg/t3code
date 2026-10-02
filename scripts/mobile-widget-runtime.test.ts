// @effect-diagnostics nodeBuiltinImport:off - Executes the actual native extension bundle in an isolated VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const mobileRoot = new URL("../apps/mobile/", import.meta.url).pathname;
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-widget-runtime-"));
const context = NodeVM.createContext({ console });
const now = Date.parse("2026-10-01T12:00:00Z");
NodeVM.runInContext(`Date.now = () => ${now}`, context);

beforeAll(() => {
  const bundle = NodePath.join(directory, "ExpoWidgets.bundle");
  NodeChildProcess.execFileSync(
    process.execPath,
    ["node_modules/expo-widgets/scripts/build-bundle.mjs", ".", "ios", bundle],
    {
      cwd: mobileRoot,
      stdio: "pipe",
    },
  );
  // Execute the real extension runtime, including Expo UI and Expo's React stub.
  // Mocked layout tests cannot catch failures while this bundle initializes.
  NodeVM.runInContext(NodeFS.readFileSync(bundle, "utf8"), context);
}, 120_000);

afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

function render(name: string, props: unknown, environment: object) {
  const layout = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const { createRequire } = require('node:module');
    const vm = require('node:vm');
    const requireMobile = createRequire(process.cwd() + '/package.json');
    const babel = requireMobile(requireMobile.resolve('@babel/core', {
      paths: [requireMobile.resolve('babel-preset-expo')]
    }));
    const result = babel.transformFileSync('src/widgets/${name}.tsx', {
      caller: { name: 'metro', platform: 'ios', supportsStaticESM: false, isDev: false }
    });
    const capture = (_, layout) => process.stdout.write(layout);
    vm.runInNewContext(result.code, {
      exports: {},
      require: name => name === 'expo-widgets'
        ? { createWidget: capture, createLiveActivity: capture } : {}
    });
  `,
    ],
    { cwd: mobileRoot, encoding: "utf8" },
  );
  NodeVM.runInContext(`globalThis.__expoWidgetLayout = (${layout})`, context);
  return NodeVM.runInContext(
    `JSON.stringify(__expoWidgetRender(${JSON.stringify(props)}, ${JSON.stringify(environment)}))`,
    context,
  ) as string;
}

it("renders the Live Activity banner and Dynamic Island with the bundled runtime", () => {
  const result = JSON.parse(
    render(
      "AgentActivity",
      {
        title: "T3 Code",
        subtitle: "Agent work in progress",
        activeCount: 1,
        activities: [
          {
            phase: "running",
            threadTitle: "Audit widgets",
            projectTitle: "T3",
            status: "Working",
            deepLink: "/threads/test",
          },
        ],
      },
      { colorScheme: "dark", isStale: false, timestamp: now },
    ),
  );
  expect(JSON.stringify(result.banner)).toContain("Audit widgets");
  expect(JSON.stringify(result.compactLeading)).toContain("ImageView");
  expect(JSON.stringify(result.compactTrailing)).toContain("1");
});

it.each(["systemSmall", "systemMedium", "systemLarge", "accessoryRectangular"])(
  "renders fresh usage and its expired state in %s",
  (widgetFamily) => {
    const props = {
      checkedAt: now,
      providers: [
        {
          name: "Codex",
          detail: "Subscription remaining",
          windows: [{ remaining: 70, label: "Session", kind: "session", reset: "Resets soon" }],
          expiresAt: now + 60_000,
          totalWindows: 1,
        },
      ],
    };
    const environment = { widgetFamily, colorScheme: "dark", widgetRenderingMode: "fullColor" };
    expect(render("SubscriptionUsage", props, { ...environment, timestamp: now })).toContain("70");
    expect(
      render("SubscriptionUsage", props, { ...environment, timestamp: now + 60_001 }),
    ).toContain("Open T3 to refresh");
  },
);
