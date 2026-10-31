import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { compileModsAsync } = require("expo/config-plugins");
const { getConfig } = require("expo/config");
const template = NodeChildProcess.execFileSync(
  "tar",
  [
    "-xOf",
    NodePath.join(NodePath.dirname(require.resolve("expo/package.json")), "template.tgz"),
    "package/android/app/src/main/java/com/helloworld/MainActivity.kt",
  ],
  { encoding: "utf8" },
);
const projectRoots = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildMainActivity(contents) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "display-metrics-plugin-"));
  projectRoots.push(projectRoot);
  const activityPath = NodePath.join(
    projectRoot,
    "android/app/src/main/java/com/helloworld/MainActivity.kt",
  );
  NodeFS.mkdirSync(NodePath.dirname(activityPath), { recursive: true });
  NodeFS.writeFileSync(activityPath, contents);
  const { exp } = getConfig(NodePath.resolve(import.meta.dirname, ".."), {
    isModdedConfig: true,
  });
  // Keep the app's registration order: Expo executes same-type mods in reverse.
  // Unrelated native-file mods need the rest of a complete prebuild project.
  const mainActivity = exp.mods?.android?.mainActivity;
  await compileModsAsync(
    { ...exp, mods: { android: mainActivity ? { mainActivity } : {} } },
    { projectRoot, platforms: ["android"] },
  );
  return NodeFS.readFileSync(activityPath, "utf8");
}

function methodBody(contents, name) {
  const methods = [
    ...contents.matchAll(
      new RegExp(`^  (?:override|private) fun ${name}\\([^]*?\\) \\{\\n([^]*?)^  \\}`, "gm"),
    ),
  ];
  expect(methods, `exactly one ${name} declaration`).toHaveLength(1);
  return methods[0][1].trim();
}

describe("withAndroidWindowDisplayMetrics", () => {
  it("rebinds the generated activity after root installation and configuration changes, preserving orientation", async () => {
    const result = await prebuildMainActivity(template);

    expect(methodBody(result, "setContentView")).toMatch(
      /^super\.setContentView\(view\)\s+DisplayMetricsHolder\.initDisplayMetrics\(this\)$/,
    );
    expect(methodBody(result, "onConfigurationChanged")).toMatch(
      /^super\.onConfigurationChanged\(newConfig\)\s+DisplayMetricsHolder\.initDisplayMetrics\(this\)\s+applyTabletOrientation\(\)$/,
    );
    const onCreate = methodBody(result, "onCreate");
    expect(onCreate).toContain("applyTabletOrientation()");
    expect(onCreate).not.toContain("DisplayMetricsHolder.initDisplayMetrics(this)");
    expect(methodBody(result, "applyTabletOrientation")).toMatch(
      /requestedOrientation = if \(resources\.configuration\.smallestScreenWidthDp >= 600\) \{\s+ActivityInfo\.SCREEN_ORIENTATION_FULL_USER\s+\} else \{\s+ActivityInfo\.SCREEN_ORIENTATION_PORTRAIT\s+\}/,
    );

    expect(result).toContain("import android.view.View");
    expect(result).toContain("import com.facebook.react.uimanager.DisplayMetricsHolder");
    expect(result.match(/^import android\.content\.res\.Configuration$/gm)).toHaveLength(1);
  });

  it("leaves the composed activity unchanged when prebuild runs again", async () => {
    const once = await prebuildMainActivity(template);
    const twice = await prebuildMainActivity(once);

    expect(methodBody(once, "setContentView")).toContain(
      "DisplayMetricsHolder.initDisplayMetrics(this)",
    );
    expect(twice).toBe(once);
  });
});
