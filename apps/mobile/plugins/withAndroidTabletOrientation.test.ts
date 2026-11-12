import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AndroidConfig, compileModsAsync, XML } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withAndroidTabletOrientation from "./withAndroidTabletOrientation.cjs";

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication">
    <activity android:name=".MainActivity" android:configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>`;

// Trimmed from the MainActivity.kt that `expo prebuild` generates for this app.
const MAIN_ACTIVITY = `package com.t3tools.t3code

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildAndroid(input = { manifest: MANIFEST, mainActivity: MAIN_ACTIVITY }) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tablet-orientation-"));
  projectRoots.push(projectRoot);
  const sourceRoot = NodePath.join(projectRoot, "android/app/src/main");
  const activityPath = NodePath.join(sourceRoot, "java/com/t3tools/t3code/MainActivity.kt");
  const manifestPath = NodePath.join(sourceRoot, "AndroidManifest.xml");
  NodeFS.mkdirSync(NodePath.dirname(activityPath), { recursive: true });
  NodeFS.writeFileSync(manifestPath, input.manifest);
  NodeFS.writeFileSync(activityPath, input.mainActivity);

  const config = withAndroidTabletOrientation({
    name: "T3 Code",
    slug: "t3code",
    orientation: "portrait",
  });
  // Prebuild registers Expo's orientation mod after app plugins. Mods run in
  // reverse order, so our plugin must remove the portrait lock Expo writes.
  await compileModsAsync(AndroidConfig.Orientation.withOrientation(config), {
    projectRoot,
    platforms: ["android"],
  });
  return {
    manifest: NodeFS.readFileSync(manifestPath, "utf8"),
    mainActivity: NodeFS.readFileSync(activityPath, "utf8"),
  };
}

describe("withAndroidTabletOrientation", () => {
  it("generates an unlocked launcher manifest while preserving rotation and fold handling", async () => {
    const { manifest } = await prebuildAndroid();
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(
      (await XML.parseXMLAsync(manifest)) as AndroidConfig.Manifest.AndroidManifest,
    );

    expect(mainActivity.$["android:screenOrientation"]).toBeUndefined();
    expect(mainActivity.$["android:configChanges"]?.split("|")).toEqual(
      expect.arrayContaining(["orientation", "screenSize", "smallestScreenSize"]),
    );
  });

  it("generates the phone/tablet policy before activity creation and stays stable on repeated prebuild", async () => {
    const once = await prebuildAndroid();

    expect(once.mainActivity).toMatch(
      /override fun onCreate\(savedInstanceState: Bundle\?\)\s*\{[^}]*applyTabletOrientation\(\)[^}]*super\.onCreate\(null\)/,
    );
    expect(once.mainActivity).toMatch(
      /private fun applyTabletOrientation\(\)\s*\{\s*requestedOrientation = if \(resources\.configuration\.smallestScreenWidthDp >= 600\)\s*\{\s*ActivityInfo\.SCREEN_ORIENTATION_FULL_USER\s*\} else \{\s*ActivityInfo\.SCREEN_ORIENTATION_PORTRAIT\s*\}/,
    );
    expect(await prebuildAndroid(once)).toEqual(once);
    const existingActivity = once.mainActivity
      .replace(
        "override fun onCreate(savedInstanceState: Bundle?) {\n    applyTabletOrientation()",
        "override fun onCreate(savedInstanceState: Bundle?) {",
      )
      .replace("super.onCreate(null)", "super.onCreate(null)\n    applyTabletOrientation()");
    expect(await prebuildAndroid({ ...once, mainActivity: existingActivity })).toEqual(once);
  });
});
